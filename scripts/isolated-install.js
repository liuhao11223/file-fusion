/**
 * isolated-install.js — end-to-end install test against an isolated ZTools
 * data root (ZTOOLS_DATA_ROOT), so the running client is not touched.
 *
 * It performs the same steps the host performs when a user installs a .zpx:
 *   1. materializeZpxAsar()  (gunzip -> brotli fallback)
 *   2. read plugin.json out of the archive
 *   3. publish the archive + the .unpacked sidecar into <root>/plugins
 *   4. write the registry record (LMDB doc ZTOOLS/plugins)
 *   5. add the plugin to the auto-start list so the client preloads it
 *
 * Then the isolated client is launched and its log is checked for the plugin
 * actually being loaded.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync, spawn } = require("node:child_process");

const LMDB_MODULE = path.join(
  "E:",
  "DSH数据库",
  "DSH会话",
  ".tmp",
  "zt",
  "lmdbtool",
  "node_modules",
  "lmdb"
);
const { open } = require(LMDB_MODULE);

const ZTOOLS_EXE = process.env.ZTOOLS_EXE || "D:/ZT/ZTools/ZTools.exe";
const ROOT = path.resolve(__dirname, "..");
const PLUGIN_SRC = path.join(ROOT, "packages");

const dataRoot = path.join(os.tmpdir(), "ztools-isolated-root");
const pluginsDir = path.join(dataRoot, "plugins");
const dbPath = path.join(dataRoot, "lmdb", "device");
const OPTS = { mapSize: 2 * 1024 * 1024 * 1024, maxDbs: 6, encoding: "binary" };

function materializeZpxAsar(zpx, dest) {
  try {
    fs.writeFileSync(dest, zlib.gunzipSync(fs.readFileSync(zpx)));
    return "gunzip";
  } catch {
    fs.writeFileSync(dest, zlib.brotliDecompressSync(fs.readFileSync(zpx)));
    return "brotli";
  }
}

function readFileFromAsar(asar, file) {
  const buf = fs.readFileSync(asar);
  const jsonLen = buf.readUInt32LE(12);
  const header = JSON.parse(buf.slice(16, 16 + jsonLen).toString("utf-8"));
  const dataBase = 8 + buf.readUInt32LE(4);
  let node = header;
  for (const part of file.split("/")) node = node.files[part];
  if (node.unpacked) return fs.readFileSync(`${asar}.unpacked/${file}`);
  return buf.slice(dataBase + Number(node.offset), dataBase + Number(node.offset) + node.size);
}

async function main() {
  // ── 1. materialize the package ────────────────────────────────────────
  const zpxPath = path.join(PLUGIN_SRC, "file-fusion-1.1.0.zpx");
  const asarSrc = path.join(PLUGIN_SRC, "file-fusion-1.1.0.asar");
  if (!fs.existsSync(zpxPath)) throw new Error(`缺少安装包：${zpxPath}`);

  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.mkdirSync(pluginsDir, { recursive: true });

  const stagedAsar = path.join(dataRoot, "staged", "plugin.asar");
  fs.mkdirSync(path.dirname(stagedAsar), { recursive: true });
  const codec = materializeZpxAsar(zpxPath, stagedAsar);
  console.log(`[1] 解压安装包 (${codec})`);

  const config = JSON.parse(readFileFromAsar(stagedAsar, "plugin.json").toString("utf-8"));
  console.log(`    插件: ${config.name} v${config.version}`);

  // ── 2. publish the archive + unpacked sidecar ─────────────────────────
  const installId = "test0001";
  const finalAsar = path.join(
    pluginsDir,
    `${config.name}-${config.version}-${installId}.asar`
  );
  fs.copyFileSync(stagedAsar, finalAsar);
  fs.cpSync(`${asarSrc}.unpacked`, `${finalAsar}.unpacked`, { recursive: true });
  console.log(`[2] 发布到 ${finalAsar}`);
  console.log(`    边车目录 ${finalAsar}.unpacked`);

  // ── 3. write the registry record ──────────────────────────────────────
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = open({ path: dbPath, ...OPTS });
  const main = await db.openDB("main", { create: true, encoding: "string" });

  const docId = "ZTOOLS/plugins";
  let doc = null;
  try {
    doc = JSON.parse(await main.get(docId));
  } catch {
    doc = { _id: docId, data: [], _rev: 0 };
  }
  const list = Array.isArray(doc.data) ? doc.data : [];

  const record = {
    name: config.name,
    title: config.title,
    version: config.version,
    description: config.description || "",
    author: config.author || "",
    homepage: config.homepage || "",
    logo: `file:///${finalAsar.replace(/\\/g, "/")}/${config.logo}`,
    main: config.main,
    preload: config.preload,
    features: config.features,
    path: finalAsar,
    storageKind: "asar",
    isDevelopment: false,
    installedAt: new Date().toISOString()
  };
  const next = list.filter((p) => p.name !== config.name).concat([record]);
  await main.put(docId, JSON.stringify({ _id: docId, data: next, _rev: doc._rev }));

  // auto-start so the client preloads the plugin at boot
  const asId = "ZTOOLS/auto-start-plugin";
  let asDoc = { _id: asId, data: [], _rev: 0 };
  try {
    const raw = await main.get(asId);
    if (raw) asDoc = JSON.parse(raw);
  } catch {
    /* first run */
  }
  await main.put(
    asId,
    JSON.stringify({
      _id: asId,
      data: (asDoc.data || []).concat([config.name]),
      _rev: asDoc._rev
    })
  );

  const check = JSON.parse(await main.get(docId));
  console.log(`[3] 注册表已写入，共 ${check.data.length} 个插件`);
  await db.close();

  // ── 4. launch the isolated client and check the log ───────────────────
  const logDir = path.join(dataRoot, "logs");
  console.log(`[4] 启动隔离客户端 (ZTOOLS_DATA_ROOT=${dataRoot})`);

  const env = { ...process.env, ZTOOLS_DATA_ROOT: dataRoot };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(ZTOOLS_EXE, [], {
    cwd: path.dirname(ZTOOLS_EXE),
    env,
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  // give the client time to boot and preload the plugin
  await new Promise((r) => setTimeout(r, 12000));

  const logPath = path.join(logDir, "main.log");
  if (!fs.existsSync(logPath)) {
    console.log("    ✗ 没有生成日志文件");
    return 1;
  }
  const log = fs.readFileSync(logPath, "utf-8");
  const lines = log.split(/\r?\n/);

  const relevant = lines.filter(
    (l) =>
      /file-fusion|插件/.test(l) &&
      /加载|preload|预加载|自动启动|Plugin|错误|失败/.test(l)
  );
  console.log("\n--- 日志中的插件相关行 ---");
  relevant.slice(-40).forEach((l) => console.log("    " + l.trim()));

  const loaded =
    /后台预加载插件完成/.test(log) && /file-fusion/.test(log);
  const noCrash = !/插件 file-fusion 加载失败|file-fusion.*Error/.test(log);

  console.log(`\n    预加载成功: ${loaded ? "是 ✅" : "否 ❌"}`);
  console.log(`    无崩溃    : ${noCrash ? "是 ✅" : "否 ❌"}`);

  return loaded && noCrash ? 0 : 1;
}

main()
  .then((code) => {
    console.log(code === 0 ? "\n隔离安装测试通过 ✅\n" : "\n隔离安装测试失败 ❌\n");
    process.exit(code);
  })
  .catch((e) => {
    console.error("ERR", e);
    process.exit(1);
  });

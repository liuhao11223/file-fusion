/**
 * release-verify.js — install the .zpx downloaded from the GitHub Release into
 * an isolated ZTools data root and confirm the plugin really loads.
 *
 * This is the end-to-end check of the *published* artifact, not of the local
 * build: the file under test is the one a user would download.
 *
 * Usage: node release-verify.js <path-to-downloaded.zpx> [--live]
 *   --live  also launches the client and checks its log
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
const zpxPath = process.argv[2];
const live = process.argv.includes("--live");

/** Load @electron/asar so the host's real extract/repack calls are used. */
function loadAsarLib() {
  const candidates = [
    path.join(__dirname, "..", "node_modules", "@electron", "asar", "lib", "asar.js")
  ];
  const npxCache = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "npm-cache",
    "_npx"
  );
  if (fs.existsSync(npxCache)) {
    for (const entry of fs.readdirSync(npxCache)) {
      candidates.push(
        path.join(npxCache, entry, "node_modules", "@electron", "asar", "lib", "asar.js")
      );
    }
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return require(c);
  }
  throw new Error("找不到 @electron/asar，请先运行 npm install");
}

const asarLib = loadAsarLib();

if (!zpxPath || !fs.existsSync(zpxPath)) {
  console.error("用法: release-verify.js <path-to-downloaded.zpx> [--live]");
  process.exit(2);
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

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
  const dataRoot = path.join(os.tmpdir(), "ztools-release-verify");
  const pluginsDir = path.join(dataRoot, "plugins");
  const dbPath = path.join(dataRoot, "lmdb", "device");
  const OPTS = { mapSize: 2 * 1024 * 1024 * 1024, maxDbs: 6, encoding: "binary" };

  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.mkdirSync(pluginsDir, { recursive: true });

  console.log(`\n安装包: ${zpxPath}\n`);

  console.log("=== 1. 解压与读取清单 ===");
  const stagedAsar = path.join(dataRoot, "staged", "plugin.asar");
  fs.mkdirSync(path.dirname(stagedAsar), { recursive: true });
  const codec = materializeZpxAsar(zpxPath, stagedAsar);
  check("安装包可解压", fs.existsSync(stagedAsar), `codec=${codec}`);

  const config = JSON.parse(readFileFromAsar(stagedAsar, "plugin.json").toString("utf-8"));
  check("plugin.json 可读", config.name === "file-fusion", `${config.name} v${config.version}`);
  check("声明了 unpack 规则", config.unpack === "*.ps1", config.unpack);

  console.log("\n=== 2. 发布归档与解包边车 ===");
  const installId = "rel00001";
  const finalAsar = path.join(pluginsDir, `${config.name}-${config.version}-${installId}.asar`);
  fs.copyFileSync(stagedAsar, finalAsar);

  // Reproduce the host's prepareZpxAsar(): extractAll the materialized
  // archive, then repack it with plugin.json.unpack so the scripts end up in
  // the .unpacked sidecar next to the installed plugin.
  const extractedDir = path.join(dataRoot, "extracted");
  fs.mkdirSync(extractedDir, { recursive: true });
  asarLib.extractAll(stagedAsar, extractedDir);
  check("宿主 extractAll 成功", fs.existsSync(path.join(extractedDir, "plugin.json")));

  fs.rmSync(finalAsar, { force: true });
  await asarLib.createPackageWithOptions(extractedDir, finalAsar, { unpack: config.unpack });

  const sidecarFiles = [];
  const collect = (dir, base) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) collect(full, path.join(base, e.name));
      else sidecarFiles.push(path.join(base, e.name));
    }
  };
  collect(`${finalAsar}.unpacked`, "");
  check("边车目录含 3 个 .ps1", sidecarFiles.filter((f) => f.endsWith(".ps1")).length === 3,
    sidecarFiles.join(", "));

  console.log("\n=== 3. 写入注册表 ===");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = open({ path: dbPath, ...OPTS });
  const main = await db.openDB("main", { create: true, encoding: "string" });
  const docId = "ZTOOLS/plugins";
  let doc = { _id: docId, data: [], _rev: 0 };
  try {
    doc = JSON.parse(await main.get(docId));
  } catch {
    /* fresh */
  }
  const record = {
    name: config.name,
    title: config.title,
    version: config.version,
    description: config.description || "",
    logo: `file:///${finalAsar.replace(/\\/g, "/")}/${config.logo}`,
    main: config.main,
    preload: config.preload,
    features: config.features,
    path: finalAsar,
    storageKind: "asar",
    isDevelopment: false,
    installedAt: new Date().toISOString()
  };
  await main.put(
    docId,
    JSON.stringify({
      _id: docId,
      data: (doc.data || []).filter((p) => p.name !== config.name).concat([record]),
      _rev: doc._rev
    })
  );
  const asId = "ZTOOLS/auto-start-plugin";
  await main.put(asId, JSON.stringify({ _id: asId, data: [config.name], _rev: 0 }));
  const check1 = JSON.parse(await main.get(docId));
  check("注册表已写入", check1.data.some((p) => p.name === "file-fusion"));
  await db.close();

  console.log("\n=== 4. 运行时探针（PowerShell 助手）===");
  const probe = path.join(__dirname, "runtime-probe.js");
  let probeOut = "";
  let probeFailed = false;
  try {
    probeOut = execFileSync(ZTOOLS_EXE, [probe, finalAsar], {
      encoding: "utf-8",
      timeout: 90000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
  } catch (e) {
    probeFailed = true;
    probeOut = `${e.stdout || ""}${e.message}`;
  }
  probeOut
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .forEach((l) => console.log(`        ${l.trim()}`));
  check("PowerShell 助手可执行", !probeFailed && probeOut.includes("PROBE_OK"));
  check("路径解析到 .asar.unpacked", probeOut.includes("inUnpacked=true"));

  if (live) {
    console.log("\n=== 5. 启动隔离客户端 ===");
    const env = { ...process.env, ZTOOLS_DATA_ROOT: dataRoot };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(ZTOOLS_EXE, [], {
      cwd: path.dirname(ZTOOLS_EXE),
      env,
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    await new Promise((r) => setTimeout(r, 12000));
    const logPath = path.join(dataRoot, "logs", "main.log");
    if (!fs.existsSync(logPath)) {
      check("客户端生成日志", false);
    } else {
      const log = fs.readFileSync(logPath, "utf-8");
      check("客户端预加载了插件", /后台预加载插件完成/.test(log) && /file-fusion/.test(log));
      check("悬浮窗窗口已创建", /pluginWindow:create.*file-fusion/.test(log));
    }
  }

  // The isolated client may still hold the data root; a failed cleanup must
  // not mask the verification result.
  try {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  } catch {
    console.log(`  (提示：临时目录 ${dataRoot} 未清理，可手动删除)`);
  }
  console.log(`\n${failures === 0 ? "发布包校验通过 ✅" : `${failures} 项失败 ❌`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});

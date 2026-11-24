/**
 * verify-package.js — end-to-end check of the built .zpx package.
 *
 * It reproduces what ZTools does when a user installs the package:
 *   1. materializeZpxAsar()  : gunzip, fall back to brotli
 *   2. prepareZpxAsar()     : read plugin.json out of the asar, apply the
 *                             `unpack` patterns, rebuild the archive with the
 *                             unpacked sidecar
 *   3. run the plugin's own lib/paths.js from INSIDE the installed archive and
 *      make sure the PowerShell helper actually executes
 *
 * This script runs under plain Node. Step 3 needs Electron's asar shim, so it
 * is executed in a separate Electron process (scripts/runtime-probe.js).
 *
 * Usage:
 *   node verify-package.js
 *   ZTOOLS_EXE="D:/ZT/ZTools/ZTools.exe" node verify-package.js
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname);
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin.json"), "utf-8"));
const baseName = `file-fusion-${manifest.version}`;
const packagesDir = path.join(ROOT, "packages");
const asarPath = path.join(packagesDir, `${baseName}.asar`);
const zpxPath = path.join(packagesDir, `${baseName}.zpx`);

let failures = 0;
let skipped = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function skip(label, detail) {
  console.log(`  SKIP  ${label}${detail ? ` — ${detail}` : ""}`);
  skipped++;
}

/** host: materializeZpxAsar — gunzip first, brotli as fallback */
function materializeZpxAsar(zpx, dest) {
  try {
    fs.writeFileSync(dest, zlib.gunzipSync(fs.readFileSync(zpx)));
    return "gunzip";
  } catch {
    fs.writeFileSync(dest, zlib.brotliDecompressSync(fs.readFileSync(zpx)));
    return "brotli";
  }
}

/** host: readFileFromAsar — read one file out of an asar without extracting */
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

/** host: listAsarFiles */
function listAsarFiles(asar) {
  const buf = fs.readFileSync(asar);
  const jsonLen = buf.readUInt32LE(12);
  const header = JSON.parse(buf.slice(16, 16 + jsonLen).toString("utf-8"));
  const out = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files || {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      out.push(p);
      if (child.files) walk(child, p);
    }
  };
  walk(header, "");
  return out;
}

/** Locate an Electron binary that provides the asar shim. */
function findElectronBinary() {
  const candidates = [
    process.env.ZTOOLS_EXE,
    "D:/ZT/ZTools/ZTools.exe",
    "D:/DSH/DeepSeek Harness.exe",
    path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "Programs",
      "ZTools",
      "ZTools.exe"
    )
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Load @electron/asar so the verification can run the host's real
 * extractAll()/createPackageWithOptions() calls instead of a hand-written
 * approximation.
 */
function loadAsar() {
  const roots = [
    path.join(ROOT, "node_modules", "@electron", "asar", "lib", "asar.js"),
    path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "npm-cache",
      "_npx"
    )
  ];
  // npx cache: find the first @electron/asar
  for (const root of roots.slice(1)) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      const candidate = path.join(root, entry, "node_modules", "@electron", "asar", "lib", "asar.js");
      if (fs.existsSync(candidate)) {
        roots.unshift(candidate);
        break;
      }
    }
  }
  for (const candidate of roots) {
    if (candidate && fs.existsSync(candidate)) return require(candidate);
  }
  return null;
}

const asarLib = loadAsar();
if (!asarLib) {
  console.error("找不到 @electron/asar，请先运行 npm install");
  process.exit(2);
}
const extractAll = asarLib.extractAll;
const createPackageWithOptions = asarLib.createPackageWithOptions;

console.log("\n=== 1. 包文件存在性 ===");
check(".zpx 安装包存在", fs.existsSync(zpxPath), path.basename(zpxPath));
check(".asar 归档存在", fs.existsSync(asarPath), path.basename(asarPath));

console.log("\n=== 2. zpx 格式（brotli 压缩的 asar）===");
const zpxBuf = fs.readFileSync(zpxPath);
const asarBuf = fs.readFileSync(asarPath);
check("brotli 解压结果 === asar", zlib.brotliDecompressSync(zpxBuf).equals(asarBuf));
let gunzipWorks = true;
try {
  zlib.gunzipSync(zpxBuf);
} catch {
  gunzipWorks = false;
}
check("gunzip 会失败 → 宿主走 brotli 回退分支", !gunzipWorks);

async function main() {
  console.log("\n=== 3. 宿主安装流程模拟（prepareZpxAsar）===");
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "zpx-verify-"));
  let parsed = null;
  try {
    const installedAsar = path.join(workDir, "plugin.asar");
    const codec = materializeZpxAsar(zpxPath, installedAsar);
    check("materializeZpxAsar 成功", fs.existsSync(installedAsar), `codec=${codec}`);

    parsed = JSON.parse(readFileFromAsar(installedAsar, "plugin.json").toString("utf-8"));
    check("plugin.json 可从 asar 读取", !!parsed.name, `name=${parsed.name}`);

    const files = listAsarFiles(installedAsar);
    const ps1Files = files.filter((f) => f.endsWith(".ps1"));
    check("unpack 模式覆盖全部 .ps1", ps1Files.length === 3, ps1Files.join(", "));

    // The archive that ships inside the .zpx must NOT contain unpacked
    // entries: the host extracts it with asar.extractAll(), which reads
    // unpacked entries from a sidecar that a .zpx does not carry.
    const rawInstalled = fs.readFileSync(installedAsar);
    const installedHeader = JSON.parse(
      rawInstalled.slice(16, 16 + rawInstalled.readUInt32LE(12)).toString("utf-8")
    );
    const unpackedEntries = [];
    const walkUnpacked = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files || {})) {
        const rel = prefix ? `${prefix}/${name}` : name;
        if (child.files) walkUnpacked(child, rel);
        else if (child.unpacked) unpackedEntries.push(rel);
      }
    };
    walkUnpacked(installedHeader, "");
    check(
      "归档内无 unpack 条目（宿主 extractAll 才能成功）",
      unpackedEntries.length === 0,
      unpackedEntries.join(", ")
    );

    // Reproduce the host's remaining steps: extractAll -> repack with
    // plugin.json.unpack -> publish archive + sidecar.
    const extractedDir = path.join(workDir, "extracted");
    fs.mkdirSync(extractedDir, { recursive: true });
    extractAll(installedAsar, extractedDir);
    check("宿主 extractAll 成功（无需边车）", fs.existsSync(path.join(extractedDir, "plugin.json")));

    const installedDir = path.join(workDir, "installed");
    fs.mkdirSync(installedDir, { recursive: true });
    const finalAsar = path.join(installedDir, `${parsed.name}-${parsed.version}-test1234.asar`);
    await createPackageWithOptions(extractedDir, finalAsar, { unpack: parsed.unpack });

    const sidecar = `${finalAsar}.unpacked`;
    const sidecarFiles = [];
    const collect = (dir, base) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) collect(full, path.join(base, e.name));
        else sidecarFiles.push(path.join(base, e.name));
      }
    };
    collect(sidecar, "");
    check(
      "宿主重打包后生成边车目录（含 3 个 .ps1）",
      sidecarFiles.filter((f) => f.endsWith(".ps1")).length === 3,
      sidecarFiles.join(", ")
    );
    check(
      "安装布局就绪（asar + .unpacked）",
      fs.existsSync(finalAsar) && fs.existsSync(sidecar)
    );

    console.log("\n=== 4. 运行时：PowerShell 助手能否真正执行 ===");
    const electron = findElectronBinary();
    if (!electron) {
      skip("未找到 Electron 可执行文件", "设置 ZTOOLS_EXE 后重跑");
    } else {
      const probe = path.join(ROOT, "scripts", "runtime-probe.js");
      let probeOut = "";
      let probeFailed = false;
      try {
        probeOut = execFileSync(electron, [probe, finalAsar], {
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
      check("PowerShell 助手在安装布局下可执行", !probeFailed && probeOut.includes("PROBE_OK"));
      check("解析到 .asar.unpacked 真实路径", probeOut.includes("inUnpacked=true"));
    }
    check("宿主能读到 plugin.json 的 unpack 字段", parsed.unpack === "*.ps1", parsed.unpack);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  console.log("\n=== 5. 归档内容完整性 ===");
  const files = listAsarFiles(asarPath);
  const required = [
    "plugin.json",
    "preload.js",
    "ball-preload.js",
    "ball.html",
    "ball.js",
    "ball.css",
    "index.html",
    "logo.png",
    "package.json",
    "lib/fusion.js",
    "lib/paths.js",
    "lib/explorer-select.ps1",
    "lib/explorer-watch.ps1",
    "lib/explorer-lib.ps1"
  ];
  for (const r of required) check(`包含 ${r}`, files.includes(r));
  check("不含仓库元数据", !files.some((f) => f.startsWith(".git") || f.startsWith("scripts/")));

  console.log("\n=== 6. 宿主校验规则（validatePluginConfig）===");
  check("有 name", !!parsed.name, parsed.name);
  check("有 version", !!parsed.version, parsed.version);
  check("features 非空", Array.isArray(parsed.features) && parsed.features.length > 0);
  check("每个 feature 都有 code 和 cmds", parsed.features.every((f) => f.code && Array.isArray(f.cmds)));
  check("有 main（UI 插件）", !!parsed.main, parsed.main);
  check("有 preload", !!parsed.preload, parsed.preload);
  check("有 logo", !!parsed.logo, parsed.logo);

  console.log("\n=== 7. 源码已接入 paths.js ===");
  check(
    "preload.js 引入 paths.js",
    fs.readFileSync(path.join(ROOT, "preload.js"), "utf-8").includes('require("./lib/paths.js")')
  );
  check(
    "ball-preload.js 引入 paths.js",
    fs.readFileSync(path.join(ROOT, "ball-preload.js"), "utf-8").includes('require("./lib/paths.js")')
  );
  check(
    "preload.js 用 resolveScriptPath 取脚本",
    fs
      .readFileSync(path.join(ROOT, "preload.js"), "utf-8")
      .includes('resolveScriptPath(path.join(__dirname, "lib")')
  );
  check(
    "ball-preload.js 用 resolveScriptPath 取脚本",
    fs
      .readFileSync(path.join(ROOT, "ball-preload.js"), "utf-8")
      .includes('resolveScriptPath(path.join(__dirname, "lib")')
  );

  console.log(
    `\n${failures === 0 ? "全部通过 ✅" : `${failures} 项失败 ❌`}${skipped ? `（跳过 ${skipped} 项）` : ""}\n`
  );

process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
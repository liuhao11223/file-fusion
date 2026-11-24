/**
 * scripts/make-package.js — build the official ZTools installer for file-fusion.
 *
 * Output (written to packages/):
 *   - file-fusion-<version>.asar  the unpacked asar archive (for manual installs)
 *   - file-fusion-<version>.zpx   the official installer package
 *                                 (brotli-compressed asar, double-click to install)
 *
 * The .zpx format matches what ZTools produces itself:
 *   packZpx() in the host bundle does
 *     asar.createPackage(sourceDir, tempAsar)  ->  brotli(as ar, quality 5)
 *   and the installer reads it back with
 *     materializeZpxAsar()  ->  gunzip first, brotli as fallback.
 *
 * Two packaging details matter for this plugin:
 *
 *  1. The archive must be FULLY PACKED — do not pass an unpack pattern to the
 *     asar packer. The host's own packZpx() does the same
 *     (asar.createPackage(sourceDir, tempAsarPath), no options).
 *
 *     During installation the host runs prepareZpxAsar(), which calls
 *     asar.extractAll() on the materialized archive. extractAll() reads
 *     "unpacked" entries from a "<name>.asar.unpacked" sidecar — and a .zpx
 *     carries no sidecar. An archive that already declares unpacked entries
 *     therefore makes the installer fail with
 *       ENOENT: ... plugin.asar.unpacked/lib/explorer-select.ps1
 *
 *     The host applies plugin.json.unpack itself after extracting, and only
 *     then repacks with the unpack pattern. So the .zpx has to ship the
 *     scripts packed, and plugin.json keeps "unpack": "*.ps1" so the host
 *     puts them into the sidecar of the *installed* plugin.
 *
 *  2. The PowerShell helpers in lib/*.ps1 are executed by an external process.
 *     A process cannot read a file from inside an asar archive, so the host
 *     unpacks them next to the installed archive and preload.js resolves the
 *     real path through lib/paths.js.
 *
 * The asar builder is resolved from the local npm cache when the machine is
 * offline, so packaging never depends on a live registry.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin.json"), "utf-8"));
const version = manifest.version;
const baseName = `file-fusion-${version}`;
const packagesDir = path.join(ROOT, "packages");

// Files that belong inside the archive. Everything else (git history, scripts,
// tests, npm metadata) stays out of the installed plugin.
//
// Note: package.json is NOT listed here — the script writes a minimal
// CommonJS one into the staging directory (see STAGED_PACKAGE_JSON).
const RUNTIME_FILES = [
  "LICENSE",
  "README.md",
  "ball-preload.js",
  "ball.css",
  "ball.html",
  "ball.js",
  "index.html",
  "lib",
  "logo.png",
  "plugin.json",
  "preload.js"
];

// The plugin needs a CommonJS package.json next to its preload so that
// `require("./lib/paths.js")` resolves without a bundler.
const STAGED_PACKAGE_JSON = {
  name: "file-fusion",
  version,
  type: "commonjs",
  main: "preload.js"
};

/**
 * Locate an @electron/asar installation without hitting the network.
 *
 * @returns {string|null} path to the asar CLI (asar.mjs), or null
 */
function findAsarCli() {
  const candidates = [];

  // 1) a sibling node_modules (npm install in the repo)
  candidates.push(path.join(ROOT, "node_modules", "@electron", "asar", "bin", "asar.mjs"));

  // 2) the npm exec cache (populated by a previous `npx @electron/asar` run)
  const npxCache = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
    "npm-cache",
    "_npx"
  );
  if (fs.existsSync(npxCache)) {
    for (const entry of fs.readdirSync(npxCache)) {
      candidates.push(
        path.join(npxCache, entry, "node_modules", "@electron", "asar", "bin", "asar.mjs")
      );
    }
  }

  // 3) a global install
  try {
    const globalRoot = execFileSync("npm.cmd", ["root", "-g"], {
      encoding: "utf-8"
    }).trim();
    candidates.push(path.join(globalRoot, "@electron", "asar", "bin", "asar.mjs"));
  } catch {
    // npm is not on PATH — the cache lookup above is usually enough
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function copyInto(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function build() {
  const asarCli = findAsarCli();
  if (!asarCli) {
    throw new Error(
      "找不到 @electron/asar。请先运行 `npm i -D @electron/asar`（离线环境可用 `npx @electron/asar` 预热缓存）。"
    );
  }

  fs.mkdirSync(packagesDir, { recursive: true });

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-fusion-pkg-"));
  try {
    for (const rel of RUNTIME_FILES) {
      const src = path.join(ROOT, rel);
      if (!fs.existsSync(src)) throw new Error(`缺少运行时文件：${rel}`);
      copyInto(src, path.join(stageDir, rel));
    }

    // The repo package.json carries npm publishing metadata; inside the plugin
    // it only needs to declare CommonJS.
    fs.writeFileSync(
      path.join(stageDir, "package.json"),
      JSON.stringify(STAGED_PACKAGE_JSON, null, 2),
      "utf-8"
    );

    const asarPath = path.join(packagesDir, `${baseName}.asar`);
    const zpxPath = path.join(packagesDir, `${baseName}.zpx`);

    // 1) pack the asar.
    //
    //    No --unpack here on purpose: the archive that ships inside the .zpx
    //    must be fully packed, because the host extracts it with
    //    asar.extractAll() during installation and that call needs a sidecar
    //    for unpacked entries. The host applies plugin.json.unpack itself
    //    when it repacks the installed plugin.
    execFileSync(process.execPath, [asarCli, "pack", stageDir, asarPath], { stdio: "inherit" });

    // 2) brotli-compress the asar into the installer package.
    const asarBuf = fs.readFileSync(asarPath);
    const zpxBuf = zlib.brotliCompressSync(asarBuf, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 }
    });
    fs.writeFileSync(zpxPath, zpxBuf);

    // 3) verify the round trip: the installer must get the exact asar back.
    const back = zlib.brotliDecompressSync(zpxBuf);
    if (!back.equals(asarBuf)) throw new Error("zpx 解压结果与 asar 不一致");

    console.log(`\n  asar : ${asarPath}  (${asarBuf.length} 字节)`);
    console.log(`  zpx  : ${zpxPath}  (${zpxBuf.length} 字节)`);

    // 4) the archive must not contain unpacked entries — the installer would
    //    fail with ENOENT on the missing sidecar.
    const jsonLen = asarBuf.readUInt32LE(12);
    const header = JSON.parse(asarBuf.slice(16, 16 + jsonLen).toString("utf-8"));
    const unpackedEntries = [];
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files || {})) {
        const rel = prefix ? `${prefix}/${name}` : name;
        if (child.files) walk(child, rel);
        else if (child.unpacked) unpackedEntries.push(rel);
      }
    };
    walk(header, "");
    if (unpackedEntries.length > 0) {
      throw new Error(
        `归档中含有 unpack 条目（${unpackedEntries.join(", ")}），宿主安装时会失败`
      );
    }
    console.log("  校验 : 归档内无 unpack 条目 ✅");
    console.log("");
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

build();

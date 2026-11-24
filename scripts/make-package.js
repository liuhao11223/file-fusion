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
 *  1. The PowerShell helpers in lib/*.ps1 are executed by an external
 *     process. A process cannot read a file from inside an asar archive, so the
 *     scripts are marked `unpack` in plugin.json and land in the
 *     "<name>.asar.unpacked" sidecar next to the archive. preload.js resolves
 *     the real path through lib/paths.js.
 *
 *  2. The asar builder is resolved from the local npm cache when the machine
 *     is offline, so packaging never depends on a live registry.
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

    // 1) pack the asar. `unpack` mirrors plugin.json.unpack so the PowerShell
    //    helpers end up as real files next to the archive.
    execFileSync(
      process.execPath,
      [asarCli, "pack", stageDir, asarPath, "--unpack", manifest.unpack || "*.ps1"],
      { stdio: "inherit" }
    );

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

    const unpackedDir = `${asarPath}.unpacked`;
    if (fs.existsSync(unpackedDir)) {
      const unpacked = [];
      const walk = (dir, base) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const rel = path.join(base, entry.name);
          if (entry.isDirectory()) walk(full, rel);
          else unpacked.push(rel);
        }
      };
      walk(unpackedDir, "");
      console.log(`  解包 : ${unpacked.join(", ")}`);
    }
    console.log("");
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

build();

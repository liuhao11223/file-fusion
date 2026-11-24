/**
 * scripts/runtime-probe.js — verify that the plugin's PowerShell helpers really
 * run when the plugin is installed from a .zpx package.
 *
 * Usage (must run under Electron so the asar shim is active):
 *   ELECTRON_RUN_AS_NODE=1 ZTools.exe runtime-probe.js <path-to-installed.asar>
 *
 * The probe loads lib/paths.js FROM INSIDE the installed archive — exactly how
 * preload.js does it — resolves the helper script and executes it.
 */

"use strict";

const path = require("node:path");
const { execFileSync } = require("node:child_process");

const asarPath = process.argv[2];
if (!asarPath) {
  console.error("用法: runtime-probe.js <path-to-installed.asar>");
  process.exit(2);
}

const { resolveScriptPath } = require(path.join(asarPath, "lib", "paths.js"));

const installedLib = path.join(asarPath, "lib");
const ps1 = resolveScriptPath(installedLib, "explorer-select.ps1");

console.log(`resolved=${ps1}`);
console.log(`inUnpacked=${ps1.includes(".asar.unpacked")}`);

const out = execFileSync(
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  ["-NoProfile", "-NonInteractive", "-File", ps1],
  { encoding: "utf-8", timeout: 25000 }
);

const lines = String(out)
  .split("\n")
  .map((l) => l.replace(/\r$/, ""))
  .filter((l) => l.trim());

console.log(`psFirst=${lines[0] || ""}`);
console.log(`psLines=${lines.length}`);
console.log("PROBE_OK");

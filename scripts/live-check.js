/**
 * scripts/live-check.js — verify the PowerShell helper really runs against a
 * live installed plugin (an .asar plus its .unpacked sidecar).
 *
 * Usage: node scripts/live-check.js <path-to-installed.asar>
 *
 * The plugin is loaded from inside the archive exactly like the client does it,
 * so this proves the whole chain: asar -> paths.js -> .asar.unpacked -> powershell.
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const asarPath = process.argv[2];
if (!asarPath) {
  console.error("用法: live-check.js <path-to-installed.asar>");
  process.exit(2);
}

const { resolveScriptPath } = require(path.join(asarPath, "lib", "paths.js"));
const ps1 = resolveScriptPath(path.join(asarPath, "lib"), "explorer-select.ps1");

console.log(`asar        = ${asarPath}`);
console.log(`resolved ps1= ${ps1}`);
console.log(`sidecar     = ${fs.existsSync(ps1)}`);

const out = execFileSync(
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  ["-NoProfile", "-NonInteractive", "-File", ps1],
  { encoding: "utf-8", timeout: 25000 }
);

const lines = String(out)
  .split("\n")
  .map((l) => l.replace(/\r$/, ""))
  .filter((l) => l.trim());

console.log(`ps 输出行数 = ${lines.length}`);
lines.slice(0, 6).forEach((l) => console.log(`  ${l}`));
console.log("LIVE_CHECK_OK");

// lib/paths.js — resolves the on-disk location of the plugin's PowerShell helpers.
//
// Why this file exists:
//   When the plugin is installed as a .zpx package, its files live inside an
//   Electron asar archive ("<plugin>.asar"). Inside an archive, `fs` is
//   intercepted by Electron's asar shim, so `fs.readFileSync()` works — but an
//   external process (PowerShell) receives a plain filesystem path from the OS
//   and cannot read anything inside the archive.
//
//   PowerShell refuses to run "-File <path>\inside.asar\lib\explorer-select.ps1"
//   with "The argument ... does not exist". Verified against ZTools 3.2.0.
//
//   The fix used by the official "everything" plugin: mark the scripts as
//   `unpack` in plugin.json, so the installer writes them next to the archive
//   in "<plugin>.asar.unpacked\". The helper below maps an in-archive path to
//   its unpacked twin and falls back to the original path when the plugin runs
//   from a plain directory (dev mode / npm install).

const fs = require("node:fs");
const path = require("node:path");

// Matches "<...>.asar\<rest>" — the shape Electron's asar shim produces for
// __dirname and for any path built from it.
const ASAR_RE = /^(.*\.asar)[\\/](.+)$/;

/**
 * Translate a path that points inside an asar archive to the matching file in
 * the archive's `.unpacked` sidecar directory.
 *
 * @param {string} targetPath - path built from __dirname (may point inside an asar)
 * @returns {string} the real on-disk path, or targetPath when no unpacked twin exists
 */
function resolveUnpackedPath(targetPath) {
  if (!targetPath) return targetPath;
  const match = ASAR_RE.exec(targetPath);
  if (!match) return targetPath;
  const unpackedPath = match[1] + ".unpacked" + path.sep + match[2];
  try {
    if (fs.existsSync(unpackedPath)) return unpackedPath;
  } catch {
    // fall through to the original path
  }
  return targetPath;
}

/**
 * Absolute path of a helper script inside lib/, safe to hand to PowerShell.
 *
 * @param {string} libDir - usually __dirname of the preload (…/lib)
 * @param {string} fileName - script file name, e.g. "explorer-select.ps1"
 * @returns {string} resolved absolute path
 */
function resolveScriptPath(libDir, fileName) {
  return resolveUnpackedPath(path.join(libDir, fileName));
}

module.exports = { resolveUnpackedPath, resolveScriptPath };

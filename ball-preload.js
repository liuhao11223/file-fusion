// ball-preload.js — runs inside the floating ball window.
//
// The host forces contextIsolation:false / nodeIntegration:false / sandbox:false
// for plugin child windows, so Node APIs are available here (but not in
// ball.html / ball.js).
//
// window.ztools is provided by the host's mainPreload, which is registered on
// the child window's session.
//
// Responsibilities:
//   - Read the current Explorer selection (UI Automation, non-destructive).
//   - Keep a live snapshot of the selection via a background watcher so the
//     ball can show "已选 N 项" without spawning PowerShell on every repaint.
//   - Perform dissolve / merge when the user clicks a button.
//   - Relay close / drag events to the parent window.

const { ipcRenderer } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const POWERSHELL_CANDIDATES = [
  process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : null,
  "powershell",
  "pwsh"
].filter(Boolean);

function getSettingsPath() {
  return path.join(window.ztools.getPath("userData"), "file-fusion-settings.json");
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), "utf-8"));
  } catch {
    return { dissolveRecursive: false, conflict: "rename", mergeMode: "new", mergeFlatten: false };
  }
}

function runPowerShell(script, extraArgs = []) {
  let lastError = null;
  for (const exe of POWERSHELL_CANDIDATES) {
    try {
      return execFileSync(
        exe,
        [
          "-NoProfile",
          "-NonInteractive",
          "-WindowStyle",
          "Hidden",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          ...extraArgs
        ],
        { encoding: "utf-8", timeout: 15000, windowsHide: true }
      );
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("无法启动 PowerShell");
}

function parseSelectionOutput(output) {
  const lines = String(output || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim());
  let folder = "";
  let hwnd = 0;
  const items = [];

  for (const line of lines) {
    const folderMatch = line.match(/^FOLDER=(.*)$/);
    if (folderMatch) {
      folder = folderMatch[1];
      continue;
    }
    const hwndMatch = line.match(/^WINDOW_HWND=(\d+)$/);
    if (hwndMatch) {
      hwnd = parseInt(hwndMatch[1]) || 0;
      continue;
    }
    if (/^SELECTED_COUNT=\d+$/.test(line)) continue;
    const itemMatch = line.match(/^ITEM\[\d+\]=(.+)\|(\d)\|(\d+)\|(.*)$/);
    if (itemMatch) {
      items.push({
        path: itemMatch[1],
        isFolder: itemMatch[2] === "1",
        size: parseInt(itemMatch[3]) || 0,
        modified: itemMatch[4]
      });
    }
  }
  return { folder, hwnd, items };
}

// Fresh, authoritative read of the Explorer selection.
function readExplorerSelection() {
  const psScript = path.join(__dirname, "lib", "explorer-select.ps1");
  try {
    return parseSelectionOutput(runPowerShell(psScript));
  } catch (e) {
    return { folder: "", hwnd: 0, items: [], error: e.message };
  }
}

// ── selection watcher ──
// A long-running child process watches Explorer and reports every change of
// the selection. It is only used for the live counter in the ball; the actual
// operations always use a fresh read.
let watcher = null;
let watcherBuf = "";
let watcherRestartTimer = null;
let collecting = null;
let lastSnapshot = { folder: "", hwnd: 0, items: [], updatedAt: 0 };

function notifyRenderer() {
  try {
    window.dispatchEvent(new CustomEvent("ball-selection", { detail: lastSnapshot }));
  } catch {}
}

function stopWatcher() {
  if (watcherRestartTimer) {
    clearTimeout(watcherRestartTimer);
    watcherRestartTimer = null;
  }
  if (watcher) {
    try {
      watcher.kill();
    } catch {}
    watcher = null;
  }
}

function startWatcher() {
  stopWatcher();
  const psScript = path.join(__dirname, "lib", "explorer-watch.ps1");
  let exe = POWERSHELL_CANDIDATES[0];
  for (const candidate of POWERSHELL_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) {
        exe = candidate;
        break;
      }
    } catch {}
  }

  try {
    watcher = spawn(
      exe,
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        psScript,
        "-IntervalMs",
        "900",
        "-MaxSeconds",
        "3600"
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch (e) {
    watcher = null;
    return;
  }

  watcher.stdout.setEncoding("utf-8");
  watcher.stdout.on("data", (chunk) => {
    watcherBuf += chunk;
    let idx;
    while ((idx = watcherBuf.indexOf("\n")) >= 0) {
      const line = watcherBuf.slice(0, idx).replace(/\r$/, "");
      watcherBuf = watcherBuf.slice(idx + 1);
      if (!line) continue;

      if (line === "EVENT=selection") {
        // The snapshot lines follow and are terminated by "END=selection".
        collecting = [];
        continue;
      }
      if (line === "END=selection") {
        const parsed = parseSelectionOutput(collecting.join("\n"));
        collecting = [];
        lastSnapshot = Object.assign({}, parsed, { updatedAt: Date.now() });
        notifyRenderer();
        // Tell the parent that the selection changed (used by the panel).
        ipcRenderer.send("send-to-parent", "ball-selection-changed");
        continue;
      }
      if (collecting) collecting.push(line);
    }
  });

  watcher.on("exit", () => {
    watcher = null;
    if (!watcherRestartTimer) {
      watcherRestartTimer = setTimeout(() => {
        watcherRestartTimer = null;
        startWatcher();
      }, 2000);
    }
  });
  watcher.on("error", () => {
    watcher = null;
  });
}

// ── operations ──
function doDissolve(folderPaths) {
  const settings = readSettings();
  const fusion = require("./lib/fusion.js");
  const results = [];
  for (const p of folderPaths) {
    try {
      const r = fusion.dissolveFolder(p, {
        recursive: settings.dissolveRecursive,
        conflict: settings.conflict
      });
      results.push(r);
    } catch (e) {
      results.push({
        targetName: path.basename(p),
        errors: [e.message],
        summary: { totalMoved: 0, errorCount: 1 }
      });
    }
  }
  const totalMoved = results.reduce((s, r) => s + (r.summary?.totalMoved || 0), 0);
  const totalErrors = results.reduce((s, r) => s + (r.summary?.errorCount || 0), 0);
  return {
    success: totalErrors === 0,
    totalMoved,
    totalErrors,
    message: `解散 ${results.length} 个文件夹，移动 ${totalMoved} 项`
  };
}

function doMerge(paths) {
  const settings = readSettings();
  const fusion = require("./lib/fusion.js");
  const r = fusion.mergeItems(paths, {
    mode: settings.mergeMode,
    conflict: settings.conflict,
    flatten: settings.mergeFlatten
  });
  return {
    success: r.summary.errorCount === 0,
    totalMoved: r.summary.totalMoved,
    targetName: r.targetName,
    message: `合并 ${r.summary.totalMoved} 项到「${r.targetName}」`
  };
}

window.ballServices = {
  readExplorerSelection,
  doDissolve,
  doMerge,
  startWatcher,
  stopWatcher,
  getSelectionSnapshot: () => lastSnapshot,
  requestClose: () => {
    ipcRenderer.send("send-to-parent", "ball-close");
  },
  requestDragStart: (x, y) => {
    ipcRenderer.send("send-to-parent", "ball-drag-start", x, y);
  },
  requestDragMove: (x, y) => {
    ipcRenderer.send("send-to-parent", "ball-drag-move", x, y);
  },
  requestDragEnd: () => {
    ipcRenderer.send("send-to-parent", "ball-drag-end");
  },
  getCursorPoint: () => {
    return window.ztools.getCursorScreenPoint();
  }
};

window.addEventListener("beforeunload", stopWatcher);

// Kick off the watcher as soon as the ball is up.
setTimeout(startWatcher, 400);

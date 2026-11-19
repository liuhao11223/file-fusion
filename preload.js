// file-fusion preload.js — runs inside the plugin view (the ZTools plugin frame).
//
// Responsibilities:
//   1. Manage the floating ball window (create / show / hide / move).
//   2. Execute dissolve & merge on the items selected in Explorer.
//   3. Expose window.services so index.html (the settings panel) can use them.
//
// Host facts this file relies on (verified against ZTools 3.0.0):
//   - createBrowserWindow(url, options, callback): `url` MUST be a path relative
//     to the plugin directory ("ball.html"), because the host resolves it with
//     path.join(pluginPath, pathname). An absolute path produces a broken
//     file:// URL and the window stays blank (ERR_FILE_NOT_FOUND).
//   - The child window's preload path is joined the same way, so it must also
//     be relative ("ball-preload.js").
//   - sendToParent(channel, ...args) is relayed by the host as
//     __ipc_sendto_relay__ and then re-emitted on the ORIGINAL channel name.
//     Therefore the parent listens on the plain channel name
//     ("ball-close", "ball-drag-start", ...), not on "send-to-parent".
//   - The plugin view is only alive while the ZTools window is showing it.
//     hidePluginView() dispatches PluginOut, so the ball must be re-created
//     on every PluginEnter instead of being torn down.

const { ipcRenderer } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const BALL_HTML = "ball.html";
const BALL_PRELOAD = "ball-preload.js";

const POWERSHELL_CANDIDATES = [
  process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : null,
  "powershell",
  "pwsh"
].filter(Boolean);

const DEFAULT_SETTINGS = {
  dissolveRecursive: false,
  conflict: "rename",
  mergeMode: "new",
  mergeFlatten: false,
  ballX: null,
  ballY: null,
  autoShowBall: true
};

// ── settings ──
function getSettingsPath() {
  return path.join(window.ztools.getPath("userData"), "file-fusion-settings.json");
}

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(getSettingsPath(), "utf-8"));
    return Object.assign({}, DEFAULT_SETTINGS, raw);
  } catch {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

function writeSettings(s) {
  const p = getSettingsPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(Object.assign({}, DEFAULT_SETTINGS, s), null, 2), "utf-8");
}

// ── selection reader ──
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

function readExplorerSelection() {
  const psScript = path.join(__dirname, "lib", "explorer-select.ps1");
  try {
    return parseSelectionOutput(runPowerShell(psScript));
  } catch (e) {
    return { folder: "", hwnd: 0, items: [], error: e.message };
  }
}

// ── ball window management ──
let ballWin = null;

function isBallAlive() {
  try {
    return !!ballWin && !ballWin.isDestroyed();
  } catch {
    return false;
  }
}

// Keep the ball fully inside the primary work area (DIP coordinates).
function clampBallPos(x, y) {
  try {
    const displays = window.ztools.getAllDisplays() || [];
    if (!displays.length) return { x, y };
    const wa = displays[0].workArea;
    const size = ballWin && !ballWin.isDestroyed() ? ballWin.getSize() : [220, 104];
    const w = size[0] || 220;
    const h = size[1] || 104;
    return {
      x: Math.min(Math.max(x, wa.x), wa.x + wa.width - w),
      y: Math.min(Math.max(y, wa.y), wa.y + wa.height - h)
    };
  } catch {
    return { x, y };
  }
}

function positionBall() {
  if (!isBallAlive()) return;
  try {
    const settings = readSettings();
    const displays = window.ztools.getAllDisplays() || [];
    if (!displays.length) return;
    const primary = displays[0];
    const rawX = settings.ballX != null ? settings.ballX : primary.workArea.x + primary.workArea.width - 240;
    const rawY = settings.ballY != null ? settings.ballY : primary.workArea.y + primary.workArea.height - 100;
    const pos = clampBallPos(Math.round(rawX), Math.round(rawY));
    ballWin.setPosition(pos.x, pos.y);
    ballWin.show();
    ballWin.setAlwaysOnTop(true);
  } catch {}
}

function createBall(options = {}) {
  if (isBallAlive()) {
    try {
      positionBall();
    } catch {}
    return true;
  }

  const settings = readSettings();

  const winOptions = {
    width: 220,
    height: 104,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    // focusable:false keeps Explorer in the foreground, so the selection the
    // user made is still readable when the ball is clicked.
    focusable: false,
    hasShadow: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    show: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: BALL_PRELOAD,
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: false
    }
  };

  try {
    // url MUST stay relative — the host joins it with the plugin directory.
    ballWin = window.ztools.createBrowserWindow(BALL_HTML, winOptions, () => {
      positionBall();
    });
  } catch (e) {
    ballWin = null;
    window.ztools.showNotification(`悬浮窗创建失败: ${e.message}`);
    return false;
  }

  // Belt and braces: place the window even if the dom-ready callback is missed.
  setTimeout(positionBall, 300);

  if (options.silent !== true) {
    window.ztools.showToast("悬浮窗已显示", { type: "success" });
  }
  return true;
}

function closeBall() {
  if (!ballWin) return;
  try {
    if (!ballWin.isDestroyed()) ballWin.close();
  } catch {}
  ballWin = null;
}

function saveBallPosition() {
  if (!isBallAlive()) return;
  try {
    const pos = ballWin.getPosition();
    const settings = readSettings();
    settings.ballX = pos[0];
    settings.ballY = pos[1];
    writeSettings(settings);
  } catch {}
}

// ── messages coming from the floating ball ──
// The host relays sendToParent() on the original channel name, so these are
// plain channel names.
ipcRenderer.on("ball-close", () => {
  saveBallPosition();
  closeBall();
});

let dragOffset = { x: 0, y: 0 };

ipcRenderer.on("ball-drag-start", (_event, x, y) => {
  if (!isBallAlive()) return;
  try {
    const pos = ballWin.getPosition();
    dragOffset = { x: x - pos[0], y: y - pos[1] };
  } catch {
    dragOffset = { x: 0, y: 0 };
  }
});

ipcRenderer.on("ball-drag-move", (_event, x, y) => {
  if (!isBallAlive()) return;
  try {
    const pos = clampBallPos(Math.round(x - dragOffset.x), Math.round(y - dragOffset.y));
    ballWin.setPosition(pos.x, pos.y);
  } catch {}
});

ipcRenderer.on("ball-drag-end", () => {
  saveBallPosition();
});

// The ball's watcher noticed a selection change in Explorer.
ipcRenderer.on("ball-selection-changed", () => {
  // Nothing to do in the parent window for now; kept so the channel is known
  // to work and future features (e.g. updating the panel) can hook in here.
});

// ── operations ──
function dissolvePaths(folderPaths) {
  const settings = readSettings();
  const fusion = require("./lib/fusion.js");
  const results = [];
  for (const p of folderPaths) {
    try {
      results.push(
        fusion.dissolveFolder(p, {
          recursive: settings.dissolveRecursive,
          conflict: settings.conflict
        })
      );
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

function mergePaths(paths) {
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

// ── feature handlers ──
async function handleEnter(param) {
  const code = param && param.code;

  if (code === "ball-show") {
    createBall();
    return;
  }

  if (code === "ball-hide") {
    saveBallPosition();
    closeBall();
    window.ztools.showToast("悬浮窗已隐藏", { type: "info" });
    return;
  }

  if (code === "dissolve-current") {
    const sel = readExplorerSelection();
    const folders = (sel.items || []).filter((i) => i.isFolder);
    if (folders.length === 0) {
      window.ztools.showNotification(
        sel.items && sel.items.length ? "选中的项目中没有文件夹" : "未检测到选中的文件夹"
      );
      return;
    }
    const r = dissolvePaths(folders.map((f) => f.path));
    window.ztools.showNotification(r.message);
    return;
  }

  if (code === "merge-current") {
    const sel = readExplorerSelection();
    if (!sel.items || sel.items.length < 2) {
      window.ztools.showNotification("请至少选择两个项目进行合并");
      return;
    }
    const r = mergePaths(sel.items.map((i) => i.path));
    window.ztools.showNotification(r.message);
    return;
  }

  // "panel" feature: the settings panel is the plugin main view, already shown.
}

let enterQueued = false;

window.ztools.onPluginEnter(async (param) => {
  // The plugin view is created lazily. Every time ZTools shows this plugin we
  // re-create the ball, because PluginOut tears the previous one down.
  try {
    if (!enterQueued) {
      enterQueued = true;
      // Give the host a moment to finish attaching the view.
      setTimeout(() => {
        enterQueued = false;
        const settings = readSettings();
        if (settings.autoShowBall !== false) {
          createBall({ silent: true });
        }
      }, 120);
    }
    await handleEnter(param);
  } catch (e) {
    window.ztools.showNotification(`操作失败: ${e.message}`);
  }
});

window.ztools.onPluginOut((isKill) => {
  // The plugin view is about to be hidden. Keep the ball alive when it is not
  // being killed: the user expects the floating ball to stay on screen.
  saveBallPosition();
  if (isKill) closeBall();
});

// ── boot bootstrap ──
// Plugins listed in "auto-start-plugin" are preloaded by the host WITHOUT a
// PluginEnter event, so onPluginEnter alone would never create the ball.
// The preload script of the plugin view runs in that case, so create the ball
// from here. createBall() is idempotent: it re-uses a live window.
(function bootstrapBall() {
  setTimeout(() => {
    try {
      const settings = readSettings();
      if (settings.autoShowBall === false) return;
      createBall({ silent: true });
    } catch (e) {
      // ignore: the ball is optional, the plugin still works from the panel
    }
  }, 1500);
})();

// ── services for index.html ──
const fusion = require("./lib/fusion.js");
window.services = {
  readExplorerSelection,
  readSettings,
  writeSettings,
  createBall: () => createBall(),
  closeBall,
  saveBallPosition,
  dissolvePaths,
  mergePaths,
  readHistory: fusion.readHistory,
  undoRecord: fusion.undoRecord,
  clearHistory: fusion.clearHistory
};

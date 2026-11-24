/**
 * scripts/preload-smoke.js — load the plugin's preload under a mocked host and
 * check that everything the panel and the floating ball rely on still works.
 *
 * The real preload needs the host's `window.ztools` bridge, so it is stubbed
 * here. Run under Electron (asar shim) or plain Node:
 *   node scripts/preload-smoke.js [plugin-dir]
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");

const PLUGIN_DIR = process.argv[2] || path.resolve(__dirname, "..");

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ── mock the host bridge ────────────────────────────────────────────────
const notifications = [];
const toasts = [];
let pluginEnterHandler = null;
let pluginOutHandler = null;

global.window = {
  addEventListener() {},
  dispatchEvent() {},
  ztools: {
    getPath: (name) => path.join(require("node:os").tmpdir(), "ztools-smoke", name),
    showNotification: (body) => notifications.push(body),
    showToast: (msg) => toasts.push(msg),
    createBrowserWindow: () => ({ isDestroyed: () => false, setPosition() {}, show() {}, close() {} }),
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
    getCursorScreenPoint: () => ({ x: 10, y: 10 }),
    onPluginEnter: (fn) => {
      pluginEnterHandler = fn;
    },
    onPluginOut: (fn) => {
      pluginOutHandler = fn;
    }
  }
};
global.window.ztools.onPluginEnter = global.window.ztools.onPluginEnter;

// electron's ipcRenderer is not available outside the host
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") {
    return { ipcRenderer: { on() {}, send() {} } };
  }
  return originalLoad.apply(this, arguments);
};

console.log("\n=== preload.js 冒烟测试 ===");
try {
  require(path.join(PLUGIN_DIR, "preload.js"));
  check("preload.js 加载成功", true);
} catch (e) {
  check("preload.js 加载成功", false, e.message);
  console.log(e.stack);
}

const services = global.window.services;
check("暴露 window.services", !!services);
if (services) {
  const expected = [
    "readExplorerSelection",
    "readSettings",
    "writeSettings",
    "createBall",
    "closeBall",
    "saveBallPosition",
    "dissolvePaths",
    "mergePaths",
    "readHistory",
    "undoRecord",
    "clearHistory"
  ];
  for (const fn of expected) {
    check(`services.${fn} 存在`, typeof services[fn] === "function");
  }
}

check("注册了 onPluginEnter", typeof pluginEnterHandler === "function");
check("注册了 onPluginOut", typeof pluginOutHandler === "function");

if (services) {
  const settings = services.readSettings();
  check("readSettings 返回默认设置", !!settings && typeof settings === "object");
  check("默认冲突策略为 rename", settings.conflict === "rename");

  const sel = services.readExplorerSelection();
  check(
    "readExplorerSelection 返回结构",
    sel && typeof sel.folder === "string" && Array.isArray(sel.items),
    sel && sel.error ? `error=${sel.error}` : `folder=${sel.folder} items=${sel.items.length}`
  );
}

console.log("\n=== ball-preload.js 冒烟测试 ===");
try {
  require(path.join(PLUGIN_DIR, "ball-preload.js"));
  check("ball-preload.js 加载成功", true);
} catch (e) {
  check("ball-preload.js 加载成功", false, e.message);
  console.log(e.stack);
}

const ball = global.window.ballServices;
check("暴露 window.ballServices", !!ball);
if (ball) {
  for (const fn of [
    "readExplorerSelection",
    "doDissolve",
    "doMerge",
    "startWatcher",
    "stopWatcher",
    "getSelectionSnapshot",
    "requestClose",
    "requestDragStart",
    "requestDragMove",
    "requestDragEnd",
    "getCursorPoint"
  ]) {
    check(`ballServices.${fn} 存在`, typeof ball[fn] === "function");
  }
}

console.log(`\n${failures === 0 ? "全部通过 ✅" : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);

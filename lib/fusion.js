// 文件合并/解散核心逻辑（Node + 浏览器双兼容）
// 设计: 解散 = 把文件夹里的文件和子文件夹移到上一层，然后删除这个文件夹本身;
//       合并 = 把选中的文件和文件夹放进一个新建的文件夹（整体移入，不拆开）
// 所有操作记录到 history 供撤回

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function getHistoryPath() {
  const dir = typeof window !== "undefined" && window.ztools
    ? window.ztools.getPath("userData")
    : path.join(process.env.APPDATA || os.homedir(), "ztools");
  return path.join(dir, "file-fusion-history.json");
}

function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(getHistoryPath(), "utf-8"));
  } catch {
    return [];
  }
}

function writeHistory(records) {
  const p = getHistoryPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(records, null, 2), "utf-8");
}

function genUniquePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  let i = 1;
  while (fs.existsSync(path.join(dir, `${base} (${i})${ext}`))) i++;
  return path.join(dir, `${base} (${i})${ext}`);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function moveEntry(from, to, conflict = "rename") {
  let finalTo = to;
  if (fs.existsSync(to)) {
    if (conflict === "skip") return null;
    if (conflict === "overwrite") {
      fs.rmSync(to, { recursive: true, force: true });
    } else if (conflict === "rename") {
      finalTo = genUniquePath(to);
    }
  }
  fs.renameSync(from, finalTo);
  return { from, to: finalTo };
}

/**
 * 解散文件夹：把 folder 内的文件和子文件夹移到上一层，然后删除 folder 本身。
 * 里面的文件和文件夹都保留（子文件夹连同内容一起上移，不会被拆开或丢弃）；
 * 只有被解散的主文件夹在清空后删除。
 * 递归模式下：深层文件全部上浮，变空的子目录也作为空文件夹上浮（不删除），
 * 最后删除主文件夹。
 * @param {string} folderPath
 * @param {{recursive?: boolean, conflict?: string}} opts
 */
function dissolveFolder(folderPath, opts = {}) {
  const recursive = !!opts.recursive;
  const conflict = opts.conflict || "rename";
  const parentDir = path.dirname(folderPath);
  const folderName = path.basename(folderPath);
  const moved = [];
  const errors = [];

  function collectAndMove(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      errors.push(`无法读取 ${dir}: ${e.message}`);
      return;
    }
    const subDirs = [];
    for (const entry of entries) {
      const from = path.join(dir, entry.name);
      const to = path.join(parentDir, entry.name);
      try {
        if (entry.isDirectory() && recursive) {
          subDirs.push(from);
        } else {
          const result = moveEntry(from, to, conflict);
          if (result) moved.push(result);
        }
      } catch (e) {
        errors.push(`移动 ${entry.name} 失败: ${e.message}`);
      }
    }
    for (const sd of subDirs) {
      collectAndMove(sd);
      // Recursion moved all of its files up; move the now-empty subfolder up
      // as a folder instead of deleting it.
      try {
        if (fs.existsSync(sd) && fs.readdirSync(sd).length === 0) {
          const result = moveEntry(sd, path.join(parentDir, path.basename(sd)), conflict);
          if (result) moved.push(result);
        }
      } catch (e) {
        errors.push(`上移子目录 ${path.basename(sd)} 失败: ${e.message}`);
      }
    }
  }

  collectAndMove(folderPath);

  // The dissolved main folder itself is removed once empty (its contents are
  // all safely in the parent directory).
  let folderRemoved = false;
  try {
    if (fs.existsSync(folderPath) && fs.readdirSync(folderPath).length === 0) {
      fs.rmdirSync(folderPath);
      folderRemoved = true;
    }
  } catch (e) {
    errors.push(`删除 ${folderName} 失败: ${e.message}`);
  }

  const record = {
    id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    timestamp: Date.now(),
    type: "dissolve",
    target: folderPath,
    parentDir,
    targetName: folderName,
    moved,
    errors,
    folderRemoved,
    summary: {
      totalMoved: moved.length,
      errorCount: errors.length
    }
  };

  const history = readHistory();
  history.unshift(record);
  if (history.length > 50) history.length = 50;
  writeHistory(history);

  return record;
}

/**
 * 合并多个选中项到一个新建的目标文件夹。
 * 默认把选中的文件和文件夹「原样」放进新文件夹（文件夹连同其内容一起移入，
 * 不拆开、不删除任何源内容）。
 * @param {string[]} selectedPaths
 * @param {{mode?: "new"|"first", conflict?: string, flatten?: boolean}} opts
 * - mode: "new" 创建新文件夹（默认）; "first" 合并到第一个选中的文件夹
 * - flatten: true 则把每个选中文件夹的内容展开后放入目标（源文件夹清空后保留）;
 *   false（默认）则整个文件夹移入目标
 */
function mergeItems(selectedPaths, opts = {}) {
  const mode = opts.mode || "new";
  const conflict = opts.conflict || "rename";
  const flatten = !!opts.flatten;

  if (!selectedPaths || selectedPaths.length === 0) {
    return {
      id: "-", timestamp: Date.now(), type: "merge",
      moved: [], errors: ["未提供选择项"],
      summary: { totalMoved: 0, errorCount: 1 }
    };
  }

  const firstPath = selectedPaths[0];
  const baseDir = path.dirname(firstPath);
  let targetDir;
  let createdNew = false;

  if (mode === "first" && fs.statSync(firstPath).isDirectory()) {
    targetDir = firstPath;
  } else {
    const timestamp = new Date();
    const ts = `${timestamp.getFullYear()}${String(timestamp.getMonth()+1).padStart(2,"0")}${String(timestamp.getDate()).padStart(2,"0")}_${String(timestamp.getHours()).padStart(2,"0")}${String(timestamp.getMinutes()).padStart(2,"0")}${String(timestamp.getSeconds()).padStart(2,"0")}`;
    targetDir = path.join(baseDir, `合并_${ts}`);
    ensureDir(targetDir);
    createdNew = true;
  }

  const moved = [];
  const errors = [];

  for (const src of selectedPaths) {
    try {
      if (!fs.existsSync(src)) {
        errors.push(`路径不存在: ${src}`);
        continue;
      }
      if (src === targetDir) continue;

      const baseName = path.basename(src);
      const target = path.join(targetDir, baseName);

      if (flatten && fs.statSync(src).isDirectory()) {
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
          const from = path.join(src, entry.name);
          const to = path.join(targetDir, entry.name);
          try {
            const result = moveEntry(from, to, conflict);
            if (result) moved.push(result);
          } catch (e) {
            errors.push(`展开 ${entry.name} 失败: ${e.message}`);
          }
        }
        // The source folder is left in place (empty) — never delete it here.
      } else {
        const result = moveEntry(src, target, conflict);
        if (result) moved.push(result);
      }
    } catch (e) {
      errors.push(`处理 ${path.basename(src)} 失败: ${e.message}`);
    }
  }

  const record = {
    id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    timestamp: Date.now(),
    type: "merge",
    target: targetDir,
    parentDir: baseDir,
    targetName: path.basename(targetDir),
    createdNew,
    flatten,
    moved,
    errors,
    summary: {
      totalMoved: moved.length,
      errorCount: errors.length
    }
  };

  const history = readHistory();
  history.unshift(record);
  if (history.length > 50) history.length = 50;
  writeHistory(history);

  return record;
}

function undoRecord(recordId) {
  const history = readHistory();
  const idx = history.findIndex(r => r.id === recordId);
  if (idx === -1) return { success: false, errors: ["记录未找到"] };

  const record = history[idx];
  const errors = [];

  // The dissolved shell has to exist again before its children move back.
  if (record.folderRemoved) {
    try { ensureDir(record.target); } catch (e) { errors.push(`重建 ${record.targetName} 失败: ${e.message}`); }
  }

  const reverseOps = [...record.moved].reverse();
  for (const op of reverseOps) {
    try {
      if (fs.existsSync(op.to)) {
        ensureDir(path.dirname(op.from));
        fs.renameSync(op.to, op.from);
      } else {
        errors.push(`目标不存在: ${op.to}`);
      }
    } catch (e) {
      errors.push(`撤销 ${path.basename(op.to)} 失败: ${e.message}`);
    }
  }

  // Only now can the folder we created be empty again, so the removal has to
  // happen after the reverse moves.
  if (record.createdNew) {
    try {
      if (fs.existsSync(record.target) && fs.readdirSync(record.target).length === 0) {
        fs.rmdirSync(record.target);
      }
    } catch {}
  }

  history.splice(idx, 1);
  writeHistory(history);

  return { success: errors.length === 0, errors };
}

function clearHistory() {
  writeHistory([]);
}

module.exports = { readHistory, writeHistory, dissolveFolder, mergeItems, undoRecord, clearHistory, getHistoryPath };
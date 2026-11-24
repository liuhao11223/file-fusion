/**
 * scripts/fusion-smoke.js — exercise the real dissolve / merge logic on a
 * throwaway folder tree.
 *
 * It creates a sandbox under the temp dir, runs lib/fusion.js against it and
 * checks the resulting directory structure. Nothing outside the sandbox is
 * touched.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PLUGIN_DIR = process.argv[2] || path.resolve(__dirname, "..");
const fusion = require(path.join(PLUGIN_DIR, "lib", "fusion.js"));

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-smoke-"));

function write(rel, content = "x") {
  const full = path.join(sandbox, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return full;
}

function exists(rel) {
  return fs.existsSync(path.join(sandbox, rel));
}

console.log("\n=== 解散（dissolve）===");
// src/{a.txt, sub/{b.txt}}  ->  parent/{a.txt, sub/b.txt}, src removed
write("dissolve/src/a.txt");
write("dissolve/src/sub/b.txt");
const srcDir = path.join(sandbox, "dissolve", "src");
const r1 = fusion.dissolveFolder(srcDir, { recursive: false, conflict: "rename" });
check("解散成功", r1.summary.errorCount === 0, JSON.stringify(r1.summary));
check("源文件夹已删除", !exists("dissolve/src"));
check("文件上移到上一层", exists("dissolve/a.txt"));
check("子文件夹整体上移", exists("dissolve/sub/b.txt"));

console.log("\n=== 解散（递归 recursive）===");
write("rec/src/deep/x.txt");
write("rec/src/top.txt");
const r2 = fusion.dissolveFolder(path.join(sandbox, "rec", "src"), {
  recursive: true,
  conflict: "rename"
});
check("递归解散成功", r2.summary.errorCount === 0, JSON.stringify(r2.summary));
check("深层文件上浮到顶层", exists("rec/x.txt"));
check("顶层文件保留", exists("rec/top.txt"));

console.log("\n=== 合并（merge to new folder）===");
write("merge/m1.txt");
write("merge/m2.txt");
write("merge/m3.txt");
const r3 = fusion.mergeItems(
  [
    path.join(sandbox, "merge", "m1.txt"),
    path.join(sandbox, "merge", "m2.txt"),
    path.join(sandbox, "merge", "m3.txt")
  ],
  { mode: "new", conflict: "rename", flatten: false }
);
check("合并成功", r3.summary.errorCount === 0, JSON.stringify(r3.summary));
check("创建了目标文件夹", !!r3.targetName, r3.targetName);
check("三个文件都在目标文件夹内", exists(`merge/${r3.targetName}/m1.txt`) && exists(`merge/${r3.targetName}/m2.txt`) && exists(`merge/${r3.targetName}/m3.txt`));

console.log("\n=== 合并（扁平化 flatten）===");
write("flat/a.txt");
write("flat/b.txt");
const r4 = fusion.mergeItems(
  [path.join(sandbox, "flat", "a.txt"), path.join(sandbox, "flat", "b.txt")],
  { mode: "new", conflict: "rename", flatten: true }
);
check("扁平合并成功", r4.summary.errorCount === 0, JSON.stringify(r4.summary));
check("文件平铺在目标根目录", exists(`flat/${r4.targetName}/a.txt`) && exists(`flat/${r4.targetName}/b.txt`));

console.log("\n=== 重名冲突（rename / overwrite / skip）===");
write("conflict/dst/keep.txt", "old");
write("conflict/src/dup.txt", "new");
const r5 = fusion.mergeItems(
  [path.join(sandbox, "conflict", "src", "dup.txt")],
  { mode: "first", conflict: "rename", flatten: false }
);
check("重命名策略不报错", r5.summary.errorCount === 0, JSON.stringify(r5.summary));
check("原文件保留", fs.readFileSync(path.join(sandbox, "conflict", "dst", "keep.txt"), "utf-8") === "old");

console.log("\n=== 历史记录与撤销 ===");
const history = fusion.readHistory();
check("写入了历史记录", Array.isArray(history) && history.length > 0, `${history.length} 条`);
const last = history[history.length - 1];
if (last) {
  check("历史记录含 id 与 type", !!last.id && !!last.type);
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "全部通过 ✅" : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);

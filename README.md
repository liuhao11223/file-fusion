# 文件合并解散（file-fusion）

一个 ZTools 插件：在资源管理器里**多选文件/文件夹后，直接点悬浮窗按钮**完成「解散文件夹」和「合并到新文件夹」，不用打开任何对话框。带冲突处理、实时选中计数和一键撤销。

仅支持 Windows（依赖资源管理器 + PowerShell / UI Automation）。

## 功能

| 操作 | 行为 |
| --- | --- |
| **解散** | 把选中文件夹里的文件和子文件夹移到上一层（子文件夹连同内容整体上移，不拆散），然后**删除主文件夹本身**。递归模式下深层文件全部上浮，变空的子目录作为空文件夹保留在上层。 |
| **合并** | 新建 `合并_YYYYMMDD_HHmmss` 文件夹，把选中的文件和文件夹**整体放入**（嵌套结构保留）。可选「合并到第一项」或「扁平化展开」模式。 |

- 悬浮窗实时显示「已选 N 项 · M 夹」，按钮按当前选择自动点亮/置灰；
- 重名冲突三种策略：**重命名**（默认，追加 `(1)`）/ 覆盖 / 跳过；
- 每次操作写入历史（最多 50 条），设置面板里可**逐条撤销**，完整还原目录结构；
- 悬浮窗可拖拽，位置自动记忆，始终置顶且不抢资源管理器焦点。

## 悬浮窗

```
┌──────────────────────────────┐
│ ⠿   [↑ 解散]  [↓ 合并]    ✕ │
└──────────────────────────────┘
        已选 3 项 · 1 夹
```

左侧圆点手柄拖动移动，右侧 ✕ 关闭。下方小条显示实时选中数或操作结果气泡。

## 指令

在 ZTools 搜索框输入：

| 指令 | 效果 |
| --- | --- |
| `悬浮窗` / `显示悬浮窗` | 显示悬浮窗 |
| `隐藏悬浮窗` / `关闭悬浮窗` | 隐藏悬浮窗 |
| `解散` / `解散文件夹` | 直接解散当前资源管理器选中的文件夹（无需悬浮窗） |
| `合并` / `合并文件` | 直接合并当前选中的项目（无需悬浮窗） |
| `文件合并解散` | 打开设置面板（递归/冲突/合并模式/历史撤销） |

也可以在「设置 → 快捷键」里给以上指令绑定全局快捷键。

## 安装

### 方式一：本地开发目录（推荐）

1. 下载/克隆本仓库；
2. 把整个目录放到 ZTools 的开发插件目录，例如建立目录联接：

   ```powershell
   New-Item -ItemType Junction -Path "$env:USERPROFILE\.ztools\plugins-dev\file-fusion" -Target "本仓库路径"
   ```

3. 重启 ZTools，插件即被加载（开发目录插件自动注册）。

### 方式二：打包安装（.zpx 官方安装包）

仓库自带打包脚本，产物在 `packages/`：

```bash
npm install          # 安装 @electron/asar
npm run package      # 生成 .asar 与 .zpx
```

产物：

| 文件 | 说明 |
| --- | --- |
| `packages/file-fusion-<版本>.zpx` | **官方安装包**，双击或在 ZTools「设置 → 插件」里导入即可安装 |
| `packages/file-fusion-<版本>.asar` | 未压缩归档，供手工放到插件目录使用 |

打包后可以跑一遍自检：

```bash
npm run verify
```

自检会**用宿主自己的 `asar.extractAll()` / `createPackageWithOptions()` 复刻完整安装流程**（`prepareZpxAsar`），并真正执行一次 PowerShell 助手，确认打包后的插件仍能读取资源管理器选中项。

> **为什么 `.ps1` 要解包**：安装后插件文件位于 Electron 的 asar 归档内。归档里的文件可以被 `fs` 读取，但**外部进程读不到**——PowerShell 收到 `-File <路径>.asar\lib\explorer-select.ps1` 会直接报「文件不存在」。因此 `plugin.json` 里声明了 `"unpack": "*.ps1"`，宿主会把这些脚本解包到归档旁边的 `.asar.unpacked` 目录，`lib/paths.js` 再负责把归档内路径映射到真实的磁盘路径。

> **打包时不要给 asar 打包器传 `--unpack`**：`.zpx` 里的归档必须是**完全打包**的状态。宿主安装时会对解包出来的归档调用 `asar.extractAll()`，而 `extractAll()` 读取 `unpacked` 条目时需要 `<name>.asar.unpacked` 边车目录——`.zpx` 并不携带边车，归档里若自带 unpack 条目，安装会直接失败：
>
> ```
> ENOENT: no such file or directory, open '.../plugin.asar.unpacked/lib/explorer-select.ps1'
> ```
>
> 宿主自己的 `packZpx()` 同样不传 unpack 选项；`plugin.json.unpack` 是宿主在**安装阶段**解压后重新打包时才应用的。打包脚本已内置校验：若归档里出现 unpack 条目会直接报错。

### 方式三：ZIP 包

把仓库内容打成 `.zip`（保持 `plugin.json` 在压缩包根部），在 ZTools「设置 → 插件」里从本地安装。

> 注意：ZIP 安装方式下插件以目录形式存在，PowerShell 脚本直接可用，不需要解包处理。

## 工作原理

- **读取选中项**：`lib/explorer-select.ps1` 通过 UI Automation 读取前台资源管理器窗口（`CabinetWClass`）文件列表的真实选中项，**不会改动你的选择**（早期 Ctrl+A 方案会破坏多选，已弃用）；Shell COM `SelectedItems` 作为兜底。
- **实时计数**：`lib/explorer-watch.ps1` 作为长驻子进程每 900ms 轮询一次，选择变化时推送快照给悬浮窗；执行操作前总是重新读取一次权威选择。
- **悬浮窗**：`ztools.createBrowserWindow("ball.html", …)` 创建的无边框透明窗口，`focusable:false` 保证点击按钮时资源管理器仍是前台、选择仍可读；拖拽通过 `getCursorScreenPoint` + 父窗口 `setPosition` 实现。
- **文件操作**：`lib/fusion.js` 纯 Node `fs.renameSync` 移动（同盘瞬时完成），每步记录 from/to，撤销时逆序还原。

## 目录结构

```
file-fusion/
├── plugin.json          # 插件清单（指令、平台、入口、unpack 规则）
├── preload.js           # 插件视图 preload：悬浮窗管理 + 操作分发 + window.services
├── index.html           # 设置面板（预览/设置/历史撤销）
├── ball.html            # 悬浮窗页面
├── ball.css             # 悬浮窗样式
├── ball.js              # 悬浮窗渲染逻辑（按钮/拖拽/计数）
├── ball-preload.js      # 悬浮窗 preload：选择读取/监视 + 操作执行
├── logo.png             # 插件图标
├── verify-package.js    # 打包自检（模拟宿主安装流程）
├── scripts/
│   ├── make-package.js  # 打包脚本：生成 .asar + .zpx
│   ├── runtime-probe.js # 运行时探针：验证 PowerShell 助手可执行
│   ├── preload-smoke.js # preload 冒烟测试
│   └── fusion-smoke.js  # 解散/合并逻辑冒烟测试
└── lib/
    ├── fusion.js        # 解散/合并/撤销核心逻辑
    ├── paths.js         # asar 解包路径解析（归档内路径 → 真实磁盘路径）
    ├── explorer-lib.ps1 # Explorer 选择读取共享库（UIA + COM）
    ├── explorer-select.ps1  # 一次性读取选中项
    └── explorer-watch.ps1   # 长驻选择监视器
```

## 设置项

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 随 ZTools 启动自动显示 | 开 | 启动后自动弹出悬浮窗 |
| 递归解散 | 关 | 解散时递归展开所有子文件夹 |
| 重名冲突 | 重命名 | 重命名 / 覆盖 / 跳过 |
| 合并模式 | 新建文件夹 | 新建 `合并_时间戳` / 合并到第一个选中的文件夹 |
| 合并扁平化 | 关 | 开启后把选中文件夹的内容展开到目标根目录（源文件夹清空后保留） |

设置与历史保存在 ZTools userData 目录：`file-fusion-settings.json` / `file-fusion-history.json`。

## 注意事项

- 解散/合并是**移动**操作（不是复制），同盘符下瞬时完成；跨盘符时 `renameSync` 会失败并记入错误，不会丢数据。
- 「覆盖」冲突策略会删除同名目标，请谨慎使用；默认「重命名」最安全。
- 撤销只还原插件自己记录的移动；如果事后手动改动了相关文件，撤销可能部分失败（会列出具体错误）。
- 需要系统自带 Windows PowerShell 5.1（`System32\WindowsPowerShell\v1.0`），无需安装任何依赖。

## 许可

[MIT](LICENSE)
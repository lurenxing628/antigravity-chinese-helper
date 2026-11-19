# Antigravity 汉化助手

支持 **macOS 菜单栏** 与 **Windows 系统托盘** 的 Antigravity 汉化助手，通过 Antigravity 的本机调试接口加载中文界面，支持图标一键启动、随应用自动连接、轻量词库热更新、自动中文会话标题、额度重置倒计时、上下文用量显示，以及主代理与子代理的用量统计。运行时版本 **0.3.41**。

界面汉化已验证环境：**Antigravity App 2.29.0、2.31.1、2.31.2 / macOS arm64 & Windows x64 / Node.js 22+**。上下文预算使用 Antigravity 官方配置，助手保留用量和额度显示。

## 功能一览

| 功能 | 能做什么 | 怎么用 |
| --- | --- | --- |
| 界面和协作群汉化 | 翻译主界面、工具状态、语音、通知以及 Swarm 协作群看板；词库可热更新 | 安装后自动连接，在菜单栏“汉”中暂停或重新加载 |
| 自动中文标题 | 为新会话和临时问题生成中文标题，保留手动命名；包含语音和 Best of N 会话 | 启用助手后发送首条消息，无需单独配置 API Key |
| 上下文与额度 | 显示上下文用量、5 小时和每周剩余额度及重置时间 | 点击模型选择器旁的圆环查看详情 |
| 会话用量统计 | 显示首字延迟、TPS、输入、输出及缓存命中率，区分主代理和子代理 | 查看模型选择器右侧统计；悬停或点击查看明细 |
| CLI 汉化与状态栏 | 翻译终端菜单、设置、提示和额度，显示两行会话统计 | 运行 `./安装CLI汉化.command`，通过 `agy-zh` 启动 |

桌面版和 CLI 的上下文调节入口已隐藏，预算覆盖已关闭，历史保存值不再参与预算设置。上下文用量、压缩阈值、额度和统计继续显示官方数据。

## CLI 汉化与显示

已验证 **Antigravity CLI `agy 1.5.9` / macOS arm64 / Node.js 24.15.0**。

```sh
./安装CLI汉化.command
agy-zh
```

安装器创建 `~/.local/bin/agy-zh`，同时提供 `agyzh`、`agyz` 两个别名，三个入口共用词库。CLI 与桌面版以项目中的 `runtime/translations.json` 为同一词库来源，但各自安装的词库副本独立；更新 CLI 词库需重新运行 CLI 安装器。帮助页、模式提示、生成状态和工具摘要在终端排版前转换为中文；设置标签和选项值在显示时转换，列表计数与上下文用量在原生格式化前翻译，系统公告在公告组件中匹配译文。命令、快捷键和选项保持原有操作方式。

`agy-zh --help` 查看用法，`agy-zh --collect-cli` 收集命令和设置中的漏词；`agy-zh update` 更新官方 CLI。

旧版 `context` 命令及 `--main-context`、`--subagent-context` 参数不再提供预算覆盖。主 Agent 和 Sub Agent 都使用官方上下文配置。

CLI 的运行文件和汉化副本保存在 `~/Library/Application Support/AntigravityChineseHelper/cli/`。启动时读取官方版本和当前安装的词库，更新对应副本。会话统计使用 Node.js 内置 SQLite，安装入口会检查其是否可用。可用 `ANTIGRAVITY_HELPER_CLI` 指定官方 CLI 路径，用 `ANTIGRAVITY_HELPER_NODE` 指定 Node.js。

交互式 `agy-zh` 自动使用两行状态栏，沿用个人 Claude Code 插件的配色和布局，通过 Antigravity 原生 `statusLine` 接口显示。费用位置改为“首字时间”，5 小时额度使用“5h剩余”标签，间距按实际文字重新计算：

- 第一行：模型与思考强度、上下文进度条及压缩阈值、改动文件与行数、项目、5 小时剩余额度。
- 第二行：首字时间、累计输入与输出、TPS、活跃时间、缓存命中率、分支、每周剩余额度。

首字、TPS 和缓存与桌面版使用同一口径。首字和 TPS 取最近 10 条已完成回复的算术平均；单次 TPS = 输出 Token ÷（首字延迟＋流式时长）。输入 = 普通输入＋缓存读取；缓存命中率 = 缓存读取 ÷ 总输入。主代理与子代理分别显示为 `主值（子代理值）`，嵌套子代理按各自调用归属统计。子代理的首字和 TPS 按各自最近 10 条的有效样本数汇总。

统计按会话恢复：输入、输出、缓存、首字、TPS 和改动从本机会话数据库只读重建，活跃区间保存在助手的 `cli/hud-cache/` 下。重新打开或继续旧会话会恢复原统计；退出、睡眠和等待定时任务的时间不计为活跃。临时读回失败时保留上一份完整统计。未返回的数据显示 `—`。

状态栏沿用个人 Claude Code 插件的整格、完整字段对齐规则：`1 文件` 与活跃时长整体对齐，增删行数与缓存整体对齐；上下文容量与 TPS 的右端对齐。列宽由主代理内容计算，项目与分支按实际名称定宽，宽屏不继续拉散。子代理值在同一列宽内用紧凑格式显示，不为未出现的子代理留空槽；文件数与 `+299 -0 行` 等完整增删数保留，零值不省略。模型名末尾与当前思考强度重复的括号标签只显示一次。空间不足时收紧间距、标签与数字格式，窄屏隐藏子指标，再让项目和改动列让位，优先保留上下文和两种额度。使用 `--settings` 显式传入自己的 `statusLine` 时，以该次设置为准；非交互输出格式保持原样。

`agy-zh` 新主会话的自动标题使用简体中文，保留文件名、产品名及原有缩写。助手直接修改原生标题请求的语言要求，沿用官方标题模型、媒体处理和保存流程，不新增命名请求。生成前及保存前的原生标题检查继续保护已有标题和手动改名；打开历史或恢复会话本身不会重命名。CLI 临时问题沿用官方不自动命名的行为。

## 从源码构建和安装

### Windows 10 / 11

需要 Windows 10 或更新版本与 **Node.js 22 或更新版本**。Windows 版直接使用系统自带的 `.NET Framework 4.x C#` 编译器（`csc.exe`）构建原生无黑框系统托盘程序 `Antigravity汉化助手.exe`，无需额外安装 Visual Studio 或其他编译工具。支持官方安装包、nvm-windows、fnm、Volta、mise 和 Scoop 安装的 Node.js。

```powershell
git clone https://github.com/lurenxing628/antigravity-chinese-helper.git
cd antigravity-chinese-helper
.\build-windows.ps1
# 或直接双击“安装汉化助手.cmd”（未构建时会自动完成构建）
.\安装汉化助手.cmd
```

- **桌面汉化安装（`安装汉化助手.cmd`）**：将运行文件与 `Antigravity汉化助手.exe` 部署到 `%LOCALAPPDATA%\AntigravityChineseHelper\application\`，创建桌面与开始菜单快捷方式，并在当前用户注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 注册随 Antigravity 启动的轻量监听进程（双击 `关闭自动启动.cmd` 可随时注销）。
- **自定义路径环境变量（可选）**：若 Antigravity 安装在非默认目录，可设置 `ANTIGRAVITY_APP_PATH` 指向 `Antigravity.exe`；若用户数据目录自定义，可设置 `ANTIGRAVITY_DATA_DIR`。
- **CLI 两行中文状态栏安装（`安装CLI汉化.cmd`）**：在 `%USERPROFILE%\.local\bin` 生成 `agy-zh.cmd`、`agyzh.cmd`、`agyz.cmd` 并自动加入用户 `PATH`（Windows 下通过官方 `statusLine` 接口提供完整的两行中文会话统计与额度状态栏，不修改 `agy.exe` 二进制文件）。

### macOS

需要 macOS 12 或更新版本、Xcode Command Line Tools 和 Node.js 22 或更新版本。助手支持 Homebrew、nvm、fnm、Volta 和 mise 安装的 Node.js，会验证版本并跳过低于 22 的候选。

```sh
git clone https://github.com/lurenxing628/antigravity-chinese-helper.git
cd antigravity-chinese-helper
./build-app.sh
# 更新安装前，先从菜单栏退出正在运行的旧助手
./安装汉化助手.command
```

构建使用系统 Swift 和 Clang 编译器，不需要安装 npm 依赖。应用版本号自动读取 `runtime/renderer.js` 中的 `VERSION`，与运行时保持一致。首次使用若缺少编译工具，运行 `xcode-select --install` 安装后再构建。

安装器会启用随 Antigravity 自动连接，并在 `~/Applications/Antigravity汉化助手.app` 创建指向同一助手应用的入口。可将它拖到 Dock，点击即可启动或切到 Antigravity，无需先打开菜单。直接从官方图标打开 Antigravity 时，自动唤起的助手只连接，不另开应用或重启后台。

运行文件安装在 `~/Library/Application Support/AntigravityChineseHelper/application/`。助手从这里加载代码和词库。

更新安装前，如果修改过安装目录中的词库，请先保存自定义词条。安装器会用项目中的词库覆盖该文件；更新后可将自己的词条合并回新词库。

Node.js 优先使用环境变量 `ANTIGRAVITY_HELPER_NODE` 指定的路径、`~/.local/bin/node` 和版本管理器的当前或默认入口，再检查进程 `PATH`、Homebrew 等固定路径，最后按版本从高到低查找已安装版本。支持管理器的常用自定义目录环境变量；GUI 启动不会读取 `.zshrc`。需要固定某个版本时，可将它链接到 `~/.local/bin/node`；环境变量方式需由启动助手的进程传入。

## 使用

点击已安装的 **Antigravity 汉化助手** 图标启动反重力；助手已运行时，再次点击会切到已有窗口。启动中连点不会重复启动。暂停状态下点击图标只显示控制菜单，不会自动恢复汉化或启动反重力。

菜单顶部显示汉化连接状态，菜单栏的“汉”继续提供控制功能。

菜单栏提供以下操作：

- **重新加载词库**：立即应用保存后的译文；日常保存词库也会自动热更新。仅词库变化时保留圆环、统计面板和已读取的历史数据；修改主界面或协作群渲染脚本时，重新加载对应界面层。
- **暂停汉化并恢复英文 / 恢复汉化**：停止或重新启动助手的界面适配；暂停时所有已连接窗口恢复英文，圆环和自动标题也会停用。
- **通过助手启动 Antigravity**：与点击助手图标共用一条启动流程，正常启动官方应用。应用已运行时切到已有窗口。
- **打开中文词库**：编辑安装目录内的 `runtime/translations.json`，保留 JSON 格式。
- **打开使用说明**：打开本文件。
- **退出并恢复英文**：卸载本次运行的翻译层，再退出助手。

### 随 Antigravity 自动启动

安装器在当前用户的 `~/Library/LaunchAgents/local.antigravity.chinese-helper.watcher.plist` 注册启动监听器。监听器登录时运行，通过 macOS 的应用启动通知识别 Antigravity，再打开助手；监听器本身不运行 Node.js 或加载汉化。

手动暂停或退出助手后，本次 Antigravity 会话不会立即重新拉起助手。重新启动 Antigravity 后，已退出的助手会自动打开；仍在运行且已暂停的助手继续保持暂停。Antigravity 退出后，已运行的助手保持等待，供下次连接使用。

双击 **关闭自动启动.command** 可以注销监听器，当前助手保持原有运行状态。安装目录也包含此脚本；需要重新启用时，退出助手后重新运行安装器。关闭自动启动后，仍可手动打开安装目录中的 `Antigravity汉化助手.app`。

## 界面汉化与词库

词库目前有 **5264 条**，覆盖主界面、设置、菜单、对话历史、自动化、插件、工具状态和电脑操作授权等。词库匹配兼容直引号与弯引号，优先精确匹配并区分大小写。以下是主要覆盖范围：

- **对话与工具**：问卷、浏览器确认、MCP 应用提示、代码审阅、文件差异、笔记本及 PDF 工具栏等固定界面；思考计时、工具状态、任务完成和子代理空闲通知也显示中文。
- **模型与额度**：模型选择器中的思考档位、额度周期、剩余比例和刷新倒计时；自定义模型名称保持原样。
- **语音和自动化**：语音选择、音色说明、静音和语速提示；首页问候、自动化空状态、周期编辑器及计时器提示。相对时间、计数和计时器时长随原数据更新。
- **内置子代理**：7 种内置代理的名称和说明覆盖徽章、选择器、卡片及标签页；`self` 显示为“分身”。自定义代理名称和内部标识保持原样。
- **Swarm 协作群**：命令菜单、插件说明、成员操作和独立看板的概览、留言板、成员、协作图与原始数据页签。筛选、回放、状态和系统告警也支持汉化；看板支持词库热更新和恢复英文。

界面翻译保留命令实际提交值、模型和项目名称、已有或手动设置的对话标题、文件路径、用户输入、代理回复及日志。协作群的成员标识、频道值、自定义名称、任务标题、留言和生成内容同样保持原样。新会话可另行生成中文标题，见下节。应用用于操作识别的 `aria-label` 和 macOS 顶部主菜单保持原样。

固定状态文案在原生组件测量前转换，保留计数和动画。实时状态 DOM 仍跳过翻译扫描；未收录的文案保留原文。创建自动化时，内置默认引导会转换为中文，其他输入保持原样。

## 自动中文会话标题

助手启用后，接管的新会话会在首条消息发送成功后自动生成简体中文标题，并作为显式会话名称保存。语音和 Best of N 会话从已确认创建的原生轨迹读取首条输入，共用同一命名流程。正常新建会话在发送前已有创建时间也会接管；原生自动英文标题先返回时继续完成中文命名。已有会话和子代理等其他非顶层会话不处理。

新建临时问题也使用同一套中文命名流程，基于临时问题本身生成标题，保存后同步更新列表、标签页和搜索结果。恢复中断任务时从该问题的起点读取输入，避免使用继承的主对话历史。既有临时问题及其标题保持原样，未出现在临时问题列表中的辅助轨迹不接管。

未完成的命名任务和已生成的中文结果保存在 Antigravity 原生设置中。应用、助手重启或界面重新加载后，会恢复这些任务：生成中断时从原生会话读取首条消息；已有中文结果时直接补保存，不重复调用模型。摘要尚未加载时先等待。任务记录不另存用户消息正文。

手动改名会立即取消自动命名，并保存独立的保护标记，重启后仍然生效。自动保存已经发出时，手动请求排在它完成之后提交，确保手动名称最后生效；其他已启用助手的窗口遵守同一顺序。临时问题的手动命名只保护该问题，不影响主对话或其他临时问题。助手停用期间出现未记录的显式标题变化时，恢复后保留当前名称，不猜测它是自动还是手动生成。

临时问题的原生英文标题晚到时，助手会重新保存已生成的中文结果，无需再次调用模型。删除该问题会取消尚未发出的标题保存；关闭标签页仍保留已保存标题和命名任务。

标题优先使用 Antigravity 当前配置的 Flash Lite 模型，其次使用 Flash；不跟随聊天框选择的主模型，不需要另外配置 API Key。自动命名会额外调用标题模型，每次任务最多尝试两次。提示词建议生成简短标题，保留文件名和英文专名；有效中文标题不因字符数超限而被丢弃。生成请求失败或返回无效中文标题时，在同一任务中补试一次；仍失败时保留原生标题，不阻塞聊天，重启恢复时可重试未完成任务。失败后继续记录晚到的原生自动标题，避免恢复时误判为手动改名。状态记录保留失败阶段、错误码和模型编号，不保存错误正文。仅有附件而没有文字时，使用原生生成的摘要作为命名依据。无法读取或保存任务状态时暂停自动命名，正常发送和手动改名继续工作。

暂停或退出助手会移除标题挂钩并取消尚未发出保存请求的任务；已发出的保存会完成并保留任务记录，重新启用后按记录恢复。已经保存的中文标题会保留。重新加载词库不会重复生成标题。

## 上下文、额度和用量统计

### 圆环与额度

模型选择器右侧依次显示上下文、5 小时额度、周额度三个环，直接使用 Antigravity 原生圆环组件，上下文显示已用百分比，5 小时和周额度显示剩余百分比。上下文使用越高越偏黄、红；额度剩余越少越偏黄、红。三个环等大对齐，没有外侧文字和刻度线。

上下文提示保留当前已用、压缩阈值、总可用上下文（模型完整容量）和已用百分比，数字使用 `256.00K`、`1M` 格式。额度提示显示对应周期的剩余百分比和额度重置时间，例如 `02:00（2小时43分后）`；跨日显示日期，时间采用本机时区。

倒计时只在额度卡片打开期间按分钟更新，不额外请求额度接口。缺少重置时间或额度被禁用时显示 `—`；到达重置时刻后显示“已到重置时间”，剩余比例继续以服务端返回为准。

### 上下文预算

主代理和子代理的预算由 Antigravity 按各自模型及角色配置决定。助手不再显示“上下文长度”和“子代理上下文”调节表单，也不写入发送请求或原生后台的预算。旧版保存的主、子代理自定义值不再生效。

点击上下文圆环仍可查看当前已用上下文、压缩阈值、模型容量和使用比例。模型默认预算变化会随官方配置显示。

### 主代理与子代理用量

模型和圆环位于左侧，右侧统计条显示首字延迟、TPS、累计输入 Token、累计输出 Token 和缓存命中率。有子代理时，TPS、输入、输出和缓存后以括号显示子代理汇总；宽度不足时隐藏括号。

悬停统计文字或数字可查看主代理与子代理明细；也可点击固定卡片，点击外部或按 Esc 关闭。统计条按数量使用 K / M，卡片中的输入和输出固定使用 K，最多保留一位小数并省略末尾 `.0`。

- 首字延迟与 TPS 是最近 10 条已完成模型回复的算术平均，不足 10 条时按已有数量统计。单次 TPS = 输出 Token ÷ 完整调用耗时（首字延迟＋流式时长）。
- 输入包含普通输入和缓存读取；缓存命中率 = 缓存读取 ÷ 总输入。主代理与子代理分开累计，子代理汇总包含嵌套子代理。
- 数据跟随原生状态更新，模型调用完成后补齐最终用量。助手运行期间按对话缓存完整统计；切回对话时先恢复缓存再补读新增调用。首次数据未齐时显示“—”，子代理未全部就绪时保留上次完整汇总。

子代理确认结束后，助手立即释放其原生轨迹订阅，最终用量继续独立读取。读取较慢或失败时保留已有完整统计，重新进入会话或历史数据变化时再补读；恢复运行时接回订阅。切换会话和重建界面时，未变化且已确认的最终统计直接复用缓存。

圆环是独立按钮，保留原模型菜单、编辑器焦点和操作属性。暂停或退出助手时，圆环与状态适配一同卸载。

## 跟随官方更新

助手通过应用已有的本机调试接口加载翻译，官方 Antigravity 安装包和更新器保持原样。

- 当前窗口刷新后会重新加载翻译。
- 助手持续运行时，会发现新窗口，并在应用重新打开后重新连接。
- 已知文案直接复用词库；新增或改写的文案需要补充词条。
- 原生上下文菜单按分发函数的行为寻找接入点，避开固定的压缩函数名称。官方重构这条路径后，需要适配新入口。

补充词条时，从菜单栏选择“打开中文词库”，在安装目录词库的 `strings` 中添加“英文原文：中文译文”，保存即可。项目中的 `runtime` 是安装源；再次安装会更新运行文件。主界面翻译、提示框、JavaScript 原生确认框和原生上下文菜单共用这一份词库。

可以从本目录运行以下命令查看状态或收集当前界面的候选漏词：

```sh
node runtime/runner.mjs --status
node runtime/runner.mjs --collect
node runtime/runner.mjs --reload
```

`--collect` 返回主应用窗口中符合筛选条件的英文标签；它不扫描对话正文或 Swarm 看板，也不会调用在线翻译。候选项经过确认后再加入词库。

运行状态和简短日志保存在 `~/Library/Application Support/AntigravityChineseHelper/`。状态文件包含进程、连接窗口数和版本；日志记录启动、手动命令结果与错误信息。每次启动后台进程前，`helper.log` 超过 512 KiB 时仅保留末尾约 256 KiB 的完整行，再继续追加。

## 代码结构

- `runtime/translations.json`：唯一的中文词库。
- `runtime/cli.mjs`：`agy-zh` 入口、CLI 设置、版本副本与终端会话管理。
- `runtime/cli-localization.mjs`、`runtime/cli-display.mjs`：CLI 固定说明、设置标签和通用显示入口的原生汉化。
- `runtime/cli-status-localization.mjs`：CLI 生成状态、操作摘要、帮助说明和提示文案的原生显示引用。
- `runtime/cli-hud.mjs`、`runtime/cli-hud-render.mjs`、`runtime/cli-hud-metrics.mjs`：CLI 状态栏设置、固定列布局及会话持久统计。
- `runtime/cli-title-localization.mjs`：CLI 原生自动会话标题的简体中文提示词。
- `runtime/cli-notice-localization.mjs`：CLI 系统公告标题与正文的显示翻译。
- `runtime/context-policy.mjs`：桌面版与 CLI 共用的上下文覆盖开关，当前关闭。
- `runtime/cli-context.mjs`：保留的 CLI 预算适配实现，当前生产入口不启用。
- `runtime/cli-launch.c`：终端启动器，保留原终端参数、信号和原生汉化接入。
- `runtime/native-copy.mjs`：桌面后台与 CLI 共用的副本签名流程。
- `runtime/renderer.js`：界面翻译、状态渲染适配、上下文用量、原生菜单适配与卸载恢复。
- `runtime/swarm-renderer.js`：Swarm 独立看板汉化、刷新与恢复。
- `runtime/runner.mjs`：发现窗口、重新连接、热更新和本机控制接口。
- `runtime/cdp.mjs`：使用 Node.js 内置 WebSocket 的调试协议客户端。
- `runtime/backend-manager.mjs`：官方应用启动、聚焦与旧预算适配清理；生产入口停用预算覆盖。
- `runtime/backend-launch.mjs`：通过主进程调试接口接入助手后台副本，保留原生子进程生命周期。
- `runtime/backend-runtime.mjs`、`runtime/backend-hook.js`：保留的原生预算适配，供内部显式启用的开发验证使用。
- `runtime/backend-metadata.mjs`、`runtime/backend-layout.mjs`：统一解析 Mach-O 及 Go 元数据，声明和读取 `LC_NOTE` 预算预留区，验证原生指令与栈契约。
- `runtime/backend-mach.c`：短命 Mach 执行器，负责读取目标预留区、RX 页发布、停止窗口和安装描述；预算算法由 `backend-hook.js` 唯一生成。
- `packaging/Helper.swift`、`AppWatcher.swift`、`RuntimeSupport.swift`、`RunnerStatus.swift`、`GenerateIcon.swift`：macOS 菜单栏程序、启动监听、Node.js 探测与图标生成。
- `packaging/windows/HelperApp.cs`、`AppWatcher.cs`、`RuntimeSupport.cs`、`RunnerStatus.cs`、`IconGenerator.cs`：Windows 原生系统托盘程序、进程监听、Node.js 探测、日志轮转与多尺寸 `.ico` 图标生成。
- `build-app.sh`、`安装汉化助手.command`、`关闭自动启动.command`、`安装CLI汉化.command`：macOS 构建与安装脚本。
- `build-windows.ps1`（`构建Windows版.cmd`）、`安装汉化助手.cmd`、`关闭自动启动.cmd`、`安装CLI汉化.cmd`、`scripts/*.ps1`：Windows 构建、安装与自启动管理脚本。

## 验证

```sh
node --test tests/*.test.mjs
xcrun swiftc packaging/RunnerStatus.swift tests/RunnerStatusTests.swift -o /tmp/antigravity-helper-status-tests
/tmp/antigravity-helper-status-tests
xcrun swiftc -framework AppKit packaging/AppWatcher.swift tests/AppWatcherTests.swift -o /tmp/antigravity-helper-watcher-tests
/tmp/antigravity-helper-watcher-tests
xcrun swiftc packaging/RuntimeSupport.swift tests/RuntimeSupportTests.swift -o /tmp/antigravity-helper-runtime-tests
/tmp/antigravity-helper-runtime-tests
```

Node.js 测试覆盖词库刷新与页面重新加载、额度计时、统计及退出流程；生命周期回归覆盖助手持续运行时反重力退出再启动、重连后的正常退出、初始化期间取消、原生后台掉线与重启、晚到旧会话事件和恢复失败。Swift 测试覆盖启动事件去重、Node.js 选择和日志尾部保留。自动启动的系统集成可在安装后检查：打开 Antigravity，确认助手启动；退出助手，确认当前会话不会重新拉起；退出并重开 Antigravity，确认助手再次启动。

以下为保留的底层适配开发验收，普通使用不需要运行。它们在临时目标或隔离副本中显式验证旧预算实现，不代表桌面版或 CLI 已启用预算覆盖：

```sh
node tests/backend-mach.integration.mjs
node tests/backend-native.integration.mjs
node tests/backend-message-budget.integration.mjs
node tests/cli-launch.integration.mjs
node tests/cli-budget.integration.mjs
```

第一条使用自有 C 目标，覆盖四个入口所在文本页、8 个并发线程、20 次启停，以及预算预留区发布、暂停、部分安装和部分撤销时强杀执行器后的恢复；同时检查机器码不一致时拒绝覆盖。目标文本及预留区保持 RX，接管和重装沿用原 generation。

第二条创建临时后台副本和独立数据目录，使用本地空会话解析配置，不调用模型，不附加正在使用的 Antigravity。验收项包括主代理保持原值、子代理统一设置、容量限制、恢复默认、500 次并发配置解析、撤销后无 receipt 的同 generation 接管、320 次后台实际命令执行与并发启停，以及保持调试连接时正常结束应用。预留区不兼容时直接失败；并发解析本身不证明发生了 Go 栈扩容或 GC。

第三条在隔离后台中使用本机可控模型回复，通过正式发送配置和消息消费路径，比较立即发送、排队发送及空闲后发送的实际调用预算。验证以消息内容、执行编号及 `chatStartMetadata.contextWindowMetadata.maxContextTokens` 为准，同时检查原调用不提前变更、已消费的新消息采用新额度和恢复默认；不会修改用户正在使用的会话。

CLI 启动集成验证门控、参数和信号传递；保留的 CLI 预算开发集成使用本机模型回复，检查隔离主会话、子会话的调用预算及恢复默认。

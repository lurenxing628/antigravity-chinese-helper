# Antigravity 汉化助手

macOS 菜单栏汉化助手，通过 Antigravity 的本机调试接口加载中文界面，支持词库热更新、暂停和恢复英文。运行时版本 **0.3.6**。

已验证环境：**Antigravity App 2.25.0 / macOS arm64 / Node.js 24.15.0**。

## 从源码构建和安装

需要 macOS 12 或更新版本、Xcode Command Line Tools 和 Node.js 22 或更新版本。菜单栏程序会从 `~/.local/bin/node`、`/opt/homebrew/bin/node`、`/usr/local/bin/node`、`/usr/bin/node` 寻找 Node.js；使用 nvm 等版本管理器时，可将当前 Node.js 链接到 `~/.local/bin/node`。

```sh
git clone https://github.com/lurenxing628/antigravity-chinese-helper.git
cd antigravity-chinese-helper
# 更新前，先从菜单栏退出正在运行的旧助手
./build-app.sh
./安装汉化助手.command
open "$HOME/Library/Application Support/AntigravityChineseHelper/application/Antigravity汉化助手.app"
```

构建使用系统 Swift 编译器，不需要安装 npm 依赖。首次使用若缺少编译工具，运行 `xcode-select --install` 安装后再构建。

安装完成后，菜单栏会出现“汉”，并连接正在运行的 Antigravity。也可以双击 **安装汉化助手.command** 完成安装。

运行文件安装在 `~/Library/Application Support/AntigravityChineseHelper/application/`。助手从这里加载代码和词库。

## 使用

菜单栏提供以下操作：

- **重新加载词库**：立即应用保存后的译文；日常保存词库也会自动热更新。
- **暂停汉化并恢复英文 / 恢复汉化**：切换当前窗口的显示语言。
- **打开中文词库**：编辑安装目录内的 `runtime/translations.json`，保留 JSON 格式。
- **打开使用说明**：打开本文件。
- **退出并恢复英文**：卸载本次运行的翻译层，再退出助手。

启动方式为手动打开助手。本版本使用本机已有的 Node.js 22 或更新版本，没有设置登录自启动。

## 覆盖范围

词库共 **1240 条**，包括主界面、设置、模型额度、下拉框、提示框、斜杠菜单说明、历史、自动化、自定义项、官方内置技能说明、子代理界面提示和项目原生上下文菜单。额度刷新倒计时、变更文件数量和消息相对时间会随实际数值更新。

命令名称、模型产品名称、项目和对话名称、代码、代理回复以及用户输入保留原文。应用用于识别操作的 `aria-label` 保持原值，避免影响取消、焦点和菜单判断。`Thinking` 思考计时、`Found / Reading / Running / Edit` 等固定工具状态、分组摘要与子代理计数在原生过渡组件测量前转换为中文，保留原数字更新和动画。实时状态的 DOM 继续跳过翻译扫描，其他动态进度文案沿用原文；完成后的思考和耗时摘要可显示中文。创建自动化时，应用内置的默认引导会在生成草稿前转换为中文，其他输入保持原样。macOS 顶部主菜单沿用应用原菜单。

## 上下文用量圆环

模型选择器右侧依次显示上下文、5 小时额度、周额度三个环，直接使用 Antigravity 原生圆环组件，上下文显示已用百分比，5 小时和周额度显示剩余百分比。上下文使用越高越偏黄、红；额度剩余越少越偏黄、红。三个环等大对齐，没有外侧文字和刻度线。

上下文提示保留当前已用、压缩阈值、总可用上下文、模型实际上下文和已用百分比，数字使用 `256.00 K`、`1M` 格式。额度提示只显示对应周期的剩余百分比。

三个环后显示首字延迟、TPS、对话累计 Token 和缓存命中率。首字延迟与 TPS 取最近 10 条已完成模型回复的算术平均，不足 10 条按已有数量统计；TPS 按各条回复的输出 Token 除以原生生成耗时计算。累计 Token 包含普通输入、缓存读取和输出，缓存命中率为缓存读取占总输入的比例。数据跟随原生状态事件更新。

圆环是独立按钮，保留原模型菜单、编辑器焦点和操作属性。暂停或退出助手时，圆环与状态适配一同卸载。

## 跟随官方更新

助手通过应用已有的本机调试接口加载翻译，官方 Antigravity 安装包和更新器保持原样。

- 当前窗口刷新后会重新加载翻译。
- 助手持续运行时，会发现新窗口，并在应用重新打开后重新连接。
- 已知文案直接复用词库；新增或改写的文案需要补充词条。
- 原生上下文菜单按分发函数的行为寻找接入点，避开固定的压缩函数名称。官方重构这条路径后，需要适配新入口。

补充词条时，从菜单栏选择“打开中文词库”，在安装目录词库的 `strings` 中添加“英文原文：中文译文”，保存即可。项目中的 `runtime` 是安装源；再次安装会更新运行文件。主界面翻译、提示框和原生上下文菜单共用这一份词库。

可以从本目录运行以下命令查看状态或收集当前界面的候选漏词：

```sh
node runtime/runner.mjs --status
node runtime/runner.mjs --collect
node runtime/runner.mjs --reload
```

`--collect` 返回当前界面中符合筛选条件的英文标签；它不扫描对话正文，也不会调用在线翻译。候选项经过确认后再加入词库。

运行状态和简短日志保存在 `~/Library/Application Support/AntigravityChineseHelper/`。状态文件包含进程、连接窗口数和版本；日志记录启动与错误信息。

## 代码结构

- `runtime/translations.json`：唯一的中文词库。
- `runtime/renderer.js`：界面翻译、状态渲染适配、上下文用量、原生菜单适配与卸载恢复。
- `runtime/runner.mjs`：发现窗口、重新连接、热更新和本机控制接口。
- `runtime/cdp.mjs`：使用 Node.js 内置 WebSocket 的调试协议客户端。
- `packaging/Helper.swift`：菜单栏程序。
- `packaging/RunnerStatus.swift`：后台状态解码和菜单标题。
- `build-app.sh`：退出助手后，使用本机 Swift 编译器重建菜单栏 `.app`。
- `安装汉化助手.command`：退出助手后，将应用和运行文件部署到 Application Support。

## 验证

```sh
node --test tests/*.test.mjs
xcrun swiftc packaging/RunnerStatus.swift tests/RunnerStatusTests.swift -o /tmp/antigravity-helper-status-tests
/tmp/antigravity-helper-status-tests
```

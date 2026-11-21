import Foundation

@main
struct RunnerStatusTests {
    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    static func main() throws {
        let cases: [(name: String, json: String, translation: String)] = [
            (
                "汉化错误保留原始提示",
                #"{"status":"error","translatedWindows":1,"lastError":"词库重新加载失败","subagentContext":{"targetTokens":64000,"active":true,"error":null,"message":""}}"#,
                "汉化遇到问题：词库重新加载失败"
            ),
            (
                "显示汉化窗口数",
                #"{"status":"running","translatedWindows":2,"lastError":null,"subagentContext":{"targetTokens":null,"active":false,"error":null,"message":"使用子代理默认上下文"}}"#,
                "已汉化 2 个窗口"
            ),
            (
                "等待窗口时忽略旧预算提醒",
                #"{"status":"waiting","translatedWindows":0,"lastError":null,"subagentContext":{"targetTokens":64000,"active":false,"error":null,"message":"已保存。正常退出 Antigravity 后，点击“Antigravity 汉化助手”图标启动。"}}"#,
                "运行中 · 等待 Antigravity 窗口"
            ),
            (
                "已连接但没有主窗口",
                #"{"status":"running","translatedWindows":0,"lastError":null,"subagentContext":{"targetTokens":64000,"active":true,"error":null,"message":""}}"#,
                "运行中 · 等待 Antigravity 窗口"
            ),
            (
                "旧预算错误不影响汉化状态",
                #"{"status":"running","translatedWindows":1,"lastError":null,"subagentContext":{"targetTokens":64000,"active":false,"error":"助手后端已断开","message":"已保存"}}"#,
                "已汉化 1 个窗口"
            ),
            (
                "无需预算状态即可读取汉化状态",
                #"{"status":"waiting","translatedWindows":0,"lastError":null}"#,
                "运行中 · 等待 Antigravity 窗口"
            ),
            (
                "停止后显示汉化已停止",
                #"{"status":"stopped","translatedWindows":0,"lastError":null,"subagentContext":{"targetTokens":64000,"active":false,"error":null,"message":"已保存"}}"#,
                "汉化助手已停止"
            ),
            (
                "兼容忽略旧预算字段的残缺负载",
                #"{"status":"running","translatedWindows":1,"lastError":null,"subagentContext":{"targetTokens":64000}}"#,
                "已汉化 1 个窗口"
            ),
        ]

        let decoder = JSONDecoder()
        for test in cases {
            let value = try decoder.decode(RunnerStatus.self, from: Data(test.json.utf8))
            guard value.menuTitle == test.translation else {
                throw Failure(description: "\(test.name)：得到 \(value.menuTitle)")
            }
            guard value.nativeChineseTitles == nil else {
                throw Failure(description: "旧版 runner 未报告标题状态时不能当作官方后端")
            }
        }

        let titleModes = [
            ("true", "waiting-for-app", 0, "会话标题 · 直接生成中文"),
            ("false", "connected", 1, "会话标题 · 由主窗口自动改为中文"),
            ("false", "connected", 0, "会话标题 · 等待主窗口连接"),
            ("null", "connected", 1, "会话标题 · 等待确认后端状态"),
        ]
        for (native, state, windows, expected) in titleModes {
            let json = #"{"status":"running","state":"\#(state)","translatedWindows":\#(windows),"nativeChineseTitles":\#(native)}"#
            let value = try decoder.decode(RunnerStatus.self, from: Data(json.utf8))
            guard value.titleModeDescription == expected else {
                throw Failure(description: "标题模式应显示“\(expected)”")
            }
        }
        let invalidStatuses = [
            #"{"state":"running","windows":2,"message":"旧格式错误"}"#,
            #"{"status":"running","lastError":null}"#,
            #"{"translatedWindows":1,"lastError":null}"#,
        ]
        for json in invalidStatuses {
            do {
                _ = try decoder.decode(RunnerStatus.self, from: Data(json.utf8))
                throw Failure(description: "缺少 runner 必填字段时不能补默认状态")
            } catch is DecodingError {
                // 汉化状态仍遵守 runner 的必填字段契约。
            }
        }

        try checkDesktopRecovery(decoder: decoder)
        try checkLaunchArguments()
        print("RunnerStatus：\(cases.count) 个汉化状态场景、\(titleModes.count) 个标题模式、\(invalidStatuses.count) 个必填字段及桌面自动恢复检查通过")
    }

    static func checkDesktopRecovery(decoder: JSONDecoder) throws {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        func date(_ offset: TimeInterval) -> Date { start.addingTimeInterval(offset) }
        func status(at offset: TimeInterval, state: String = "waiting-for-app", portFileExists: Bool = false) throws -> RunnerStatus {
            let value: [String: Any] = [
                "status": state == "connected" ? "running" : "waiting",
                "state": state,
                "translatedWindows": state == "connected" ? 1 : 0,
                "discoveredAt": formatter.string(from: date(offset)),
                "debugPortPresent": portFileExists,
            ]
            return try decoder.decode(RunnerStatus.self, from: JSONSerialization.data(withJSONObject: value))
        }

        var original = AntigravityRun(pid: 10, launchDate: date(0), debugPortRequested: false)
        let waiting = try status(at: 8)
        guard original.needsAutomaticRestart(status: waiting, now: date(8)),
              try original.needsAutomaticRestart(status: status(at: 3600, portFileExists: true), now: date(3600)) else {
            throw Failure(description: "冷启动和稍后才接管的桌面都应自动恢复，残留端口文件不能阻止恢复")
        }
        guard try !original.needsAutomaticRestart(status: status(at: 8, state: "connected"), now: date(8)),
              try !original.needsAutomaticRestart(status: status(at: 8, state: "waiting-for-window", portFileExists: true), now: date(8)) else {
            throw Failure(description: "已经连接或正在等待窗口时应保持当前桌面运行")
        }
        for requested: Bool? in [true, nil] {
            let launched = AntigravityRun(pid: 11, launchDate: date(0), debugPortRequested: requested)
            guard !launched.needsAutomaticRestart(status: waiting, now: date(8)) else {
                throw Failure(description: "启动参数已请求端口或暂时读不到启动参数时不能自动退出")
            }
        }

        original.restartFailure = "用户取消退出"
        let reopened = AntigravityRun(pid: 12, launchDate: date(20), debugPortRequested: false)
        guard try !original.needsAutomaticRestart(status: status(at: 28), now: date(28)),
              try reopened.needsAutomaticRestart(status: status(at: 28), now: date(28)) else {
            throw Failure(description: "取消退出后应停止自动重试，再次打开同版 Desktop 应独立恢复")
        }
        guard try !reopened.needsAutomaticRestart(status: status(at: 19), now: date(20)),
              try !reopened.needsAutomaticRestart(status: status(at: 21), now: date(21)),
              try !reopened.needsAutomaticRestart(status: status(at: 28), now: date(50)) else {
            throw Failure(description: "上个进程的探测、启动宽限期内的探测和过期探测均不能触发退出")
        }
    }

    static func checkLaunchArguments() throws {
        // Keep a local child alive while reading its real macOS argv.
        for (arguments, expected) in [(["--remote-debugging-port=0"], true), (["--", "--remote-debugging-port=0"], false)] {
            let child = Process()
            let input = Pipe()
            child.executableURL = URL(fileURLWithPath: "/bin/sh")
            child.arguments = ["-c", "read line", "test-desktop"] + arguments
            child.standardInput = input
            let beforeLaunch = Date()
            try child.run()
            defer {
                input.fileHandleForWriting.closeFile()
                child.waitUntilExit()
            }
            let pid = child.processIdentifier
            guard let launched = AntigravityRun.launchDate(of: pid),
                  (beforeLaunch...Date()).contains(launched),
                  !AntigravityRun.hasExited(pid: pid, launchedAt: launched) else {
                throw Failure(description: "应能读取未经 LaunchServices 启动的进程的启动时间")
            }
            guard AntigravityRun.debugPortRequested(by: child.processIdentifier) == expected else {
                throw Failure(description: "未能按 macOS 进程的实际启动参数识别调试端口：\(arguments)")
            }
            input.fileHandleForWriting.write(Data("\n".utf8))
            child.waitUntilExit()
            guard AntigravityRun.hasExited(pid: pid, launchedAt: launched) else {
                throw Failure(description: "旧进程实际退出后应允许重新启动 Desktop")
            }
        }
    }
}

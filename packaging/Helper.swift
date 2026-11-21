import AppKit
import Darwin
import Foundation

final class HelperDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    private var statusItem: NSStatusItem!
    private let statusLine = NSMenuItem(title: "正在启动汉化…", action: nil, keyEquivalent: "")
    private let titleModeLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let launchNoticeLine = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let toggleItem = NSMenuItem(title: "暂停汉化并恢复英文", action: #selector(toggleTranslation), keyEquivalent: "")
    private let launchItem = NSMenuItem(title: "通过助手启动 Antigravity", action: #selector(launchAntigravity), keyEquivalent: "")
    private let restartItem = NSMenuItem(title: "重新启动并汉化", action: #selector(restartUnconnectedAntigravity), keyEquivalent: "")
    private var runner: Process?
    private var runnerLog: FileHandle?
    private var timer: Timer?
    private var wantsTranslation = true
    private var isQuitting = false
    private var stopping = false
    private var launching = false
    private var lastError: String?
    private var launchNotice: (message: String, pid: pid_t?)?
    private var restartingPID: pid_t?
    private var desktopRun: AntigravityRun?
    private let shutdownGracePeriod: TimeInterval = 10
    private let antigravityURL = URL(fileURLWithPath: "/Applications/Antigravity.app", isDirectory: true)

    private var canLaunchAntigravity: Bool {
        wantsTranslation && !stopping && !isQuitting && !launching && restartingPID == nil
    }

    private var homeFolder: URL { supportFolder.appendingPathComponent("application", isDirectory: true) }
    private var runtimeFolder: URL { homeFolder.appendingPathComponent("runtime", isDirectory: true) }
    private var supportFolder: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/AntigravityChineseHelper", isDirectory: true)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.title = "汉"
        statusItem.button?.toolTip = "Antigravity 汉化助手"

        let menu = NSMenu()
        statusLine.isEnabled = false
        menu.addItem(statusLine)
        titleModeLine.isEnabled = false
        titleModeLine.isHidden = true
        menu.addItem(titleModeLine)
        launchNoticeLine.isEnabled = false
        launchNoticeLine.isHidden = true
        menu.addItem(launchNoticeLine)
        menu.addItem(NSMenuItem.separator())
        launchItem.target = self
        menu.addItem(launchItem)
        restartItem.target = self
        restartItem.isHidden = true
        menu.addItem(restartItem)
        menu.addItem(item("重新加载词库", action: #selector(reloadTranslations)))
        toggleItem.target = self
        menu.addItem(toggleItem)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(item("打开中文词库", action: #selector(openTranslations)))
        menu.addItem(item("打开使用说明", action: #selector(openReadme)))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(item("退出并恢复英文", action: #selector(quitHelper)))
        statusItem.menu = menu

        if CommandLine.arguments.contains("--background") {
            startRunner()
        } else {
            launchAntigravity()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.refreshStatus()
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if wantsTranslation {
            launchAntigravity()
            return false
        }
        guard let menu = statusItem?.menu else { return false }
        sender.activate(ignoringOtherApps: true)
        // 暂停时只展示菜单，明确恢复之前不启动 Antigravity 或 runner。
        DispatchQueue.main.async {
            menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
        }
        return false
    }

    private func item(_ title: String, action: Selector) -> NSMenuItem {
        let result = NSMenuItem(title: title, action: action, keyEquivalent: "")
        result.target = self
        return result
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem === launchItem {
            return canLaunchAntigravity
        }
        if menuItem === restartItem {
            return canLaunchAntigravity && !restartItem.isHidden
        }
        return menuItem.isEnabled
    }

    private func nodeExecutable() -> URL? {
        NodeRuntime.executable(workingDirectory: runtimeFolder)
    }

    private func startRunner(retryAttempt: Int = 0) {
        guard wantsTranslation, runner?.isRunning != true, !stopping, !isQuitting else { return }
        runner = nil
        try? runnerLog?.close()
        runnerLog = nil
        let script = runtimeFolder.appendingPathComponent("runner.mjs")
        guard FileManager.default.fileExists(atPath: script.path) else {
            lastError = "请先运行“安装汉化助手.command”安装运行文件"
            refreshStatus()
            return
        }
        guard let node = nodeExecutable() else {
            lastError = "未找到 Node.js 22 或更新版本，打开说明查看运行要求"
            refreshStatus()
            return
        }

        let process = Process()
        process.executableURL = node
        process.arguments = [script.path]
        process.currentDirectoryURL = runtimeFolder
        var environment = ProcessInfo.processInfo.environment
        // The runner owns cleanup; leave one second for it to close and exit.
        environment["ANTIGRAVITY_HELPER_SHUTDOWN_TIMEOUT_MS"] = String(Int((shutdownGracePeriod - 1) * 1000))
        process.environment = environment
        do {
            try FileManager.default.createDirectory(at: supportFolder, withIntermediateDirectories: true)
            let logURL = supportFolder.appendingPathComponent("helper.log")
            runnerLog = try HelperLog.open(at: logURL)
            process.standardOutput = runnerLog
            process.standardError = runnerLog
            let startedAt = ProcessInfo.processInfo.systemUptime
            process.terminationHandler = { [weak self] finished in
                DispatchQueue.main.async {
                    self?.runnerExited(finished, startedAt: startedAt, retryAttempt: retryAttempt)
                }
            }
            try process.run()
            runner = process
            lastError = nil
            statusLine.title = "正在连接 Antigravity…"
        } catch {
            lastError = "启动失败：\(error.localizedDescription)"
            try? runnerLog?.close()
            runnerLog = nil
        }
        refreshStatus()
    }

    private func runnerExited(_ finished: Process, startedAt: TimeInterval, retryAttempt: Int) {
        guard runner === finished else { return }
        try? runnerLog?.close()
        runnerLog = nil
        let delays = [2, 5, 15]
        let nextAttempt = ProcessInfo.processInfo.systemUptime - startedAt >= 60 ? 0 : retryAttempt
        let crashed = finished.terminationReason == .uncaughtSignal || finished.terminationStatus != 0
        if wantsTranslation, !stopping, !isQuitting, crashed, nextAttempt < delays.count {
            let delay = delays[nextAttempt]
            lastError = "汉化后台意外退出（\(finished.terminationStatus)），\(delay) 秒后自动重试"
            DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(delay)) { [weak self] in
                // Manual restart replaces this process. Pausing clears it.
                guard let self = self, self.runner === finished else { return }
                self.startRunner(retryAttempt: nextAttempt + 1)
            }
        } else {
            runner = nil
            if wantsTranslation, !stopping, !isQuitting {
                lastError = crashed ? "汉化后台连续退出，请检查 helper.log 后点“重新加载词库”重试"
                                    : "汉化后台已停止，点“重新加载词库”恢复"
            }
        }
        refreshStatus()
    }

    private func stopRunner(completion: @escaping () -> Void) {
        guard let process = runner, process.isRunning else {
            runner = nil
            completion()
            return
        }
        stopping = true
        statusLine.title = "正在恢复英文…"
        process.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + shutdownGracePeriod) {
            if process.isRunning {
                let message = "恢复英文的等待时间已结束，结束汉化助手进程。\n"
                if let data = message.data(using: .utf8) { try? self.runnerLog?.write(contentsOf: data) }
                kill(process.processIdentifier, SIGKILL)
            }
        }
        DispatchQueue.global(qos: .userInitiated).async {
            process.waitUntilExit()
            DispatchQueue.main.async {
                if self.runner === process { self.runner = nil }
                self.stopping = false
                try? self.runnerLog?.close()
                self.runnerLog = nil
                completion()
            }
        }
    }

    private func refreshStatus() {
        defer { statusItem.button?.toolTip = "Antigravity 汉化助手：\(statusLine.title)" }
        toggleItem.title = wantsTranslation ? "暂停汉化并恢复英文" : "恢复汉化"
        toggleItem.isEnabled = !stopping && !launching && restartingPID == nil
        launchItem.title = launching ? "正在启动 Antigravity…" : "通过助手启动 Antigravity"
        launchItem.isEnabled = canLaunchAntigravity
        restartItem.isHidden = true
        titleModeLine.isHidden = true
        launchNoticeLine.isHidden = true
        if stopping {
            return
        }
        if !wantsTranslation {
            statusLine.title = "已暂停 · 英文界面"
            return
        }
        if let error = lastError {
            statusLine.title = error
            return
        }
        if restartingPID != nil {
            statusLine.title = "正在正常退出 Antigravity，以便重新启动汉化…"
            return
        }
        guard runner?.isRunning == true else {
            statusLine.title = "汉化助手尚未运行"
            return
        }
        if launching {
            statusLine.title = "正在通过助手启动 Antigravity…"
            return
        }
        guard let value = readRunnerStatus() else {
            statusLine.title = "正在连接 Antigravity…"
            return
        }
        statusLine.title = value.menuTitle
        let runningApp = runningAntigravity()
        let pid = runningApp?.processIdentifier
        if let previous = launchNotice?.pid, previous != pid {
            launchNotice = nil
        } else if let pid {
            launchNotice?.pid = pid
        }
        if let notice = launchNotice?.message {
            launchNoticeLine.title = notice
            launchNoticeLine.isHidden = false
        }
        guard let app = runningApp else { return }
        if let titleMode = value.titleModeDescription {
            titleModeLine.title = titleMode
            titleModeLine.isHidden = false
        }
        let now = Date()
        guard canRestart(app, status: value, now: now) else { return }
        restartItem.isHidden = false
        if let failure = desktopRun?.restartFailure {
            statusLine.title = failure
        } else if desktopRun?.needsAutomaticRestart(status: value, now: now) == true {
            restartAntigravity(app)
        } else {
            statusLine.title = "Antigravity 已打开 · 等待连接本机调试接口"
        }
    }

    private func readRunnerStatus() -> RunnerStatus? {
        let path = supportFolder.appendingPathComponent("status.json")
        guard let runner, runner.isRunning, let data = try? Data(contentsOf: path),
              let status = try? JSONDecoder().decode(RunnerStatus.self, from: data),
              status.pid == runner.processIdentifier else { return nil }
        return status
    }

    private func runningAntigravity() -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: AntigravityLaunchState.bundleIdentifier).first {
            !$0.isTerminated && $0.bundleURL?.standardizedFileURL.path == antigravityURL.path
        }
    }

    private func observeDesktopRun(_ app: NSRunningApplication) {
        let pid = app.processIdentifier
        guard let launchDate = AntigravityRun.launchDate(of: pid) else { desktopRun = nil; return }
        if let run = desktopRun, run.pid == pid, run.launchDate == launchDate,
           run.debugPortRequested != nil || run.restartFailure != nil { return }
        desktopRun = AntigravityRun(pid: pid, launchDate: launchDate, debugPortRequested: AntigravityRun.debugPortRequested(by: pid))
    }

    private func canRestart(_ app: NSRunningApplication, status: RunnerStatus, now: Date) -> Bool {
        guard canLaunchAntigravity, status.isWaitingForApp else { return false }
        observeDesktopRun(app)
        if status.discoveredAt == nil { return true } // Older runners reported only the waiting state.
        guard let launchDate = desktopRun?.launchDate else { return false }
        return status.discoveryDate(since: launchDate, now: now) != nil
    }

    @objc private func restartUnconnectedAntigravity() {
        guard let app = runningAntigravity(), let status = readRunnerStatus(), canRestart(app, status: status, now: Date()) else {
            refreshStatus()
            return
        }
        restartAntigravity(app)
    }

    private func restartAntigravity(_ app: NSRunningApplication) {
        guard canLaunchAntigravity, !app.isTerminated else { return }
        logRecovery("请求 Desktop 正常退出（PID \(app.processIdentifier)）")
        let pid = app.processIdentifier
        desktopRun?.restartFailure = nil
        guard app.terminate() else {
            logRecovery("Desktop 拒绝退出")
            desktopRun?.restartFailure = "Antigravity 未接受退出请求 · 可在菜单中重试"
            refreshStatus()
            return
        }
        restartingPID = pid
        refreshStatus()
        waitForAntigravityExit(until: .now() + 20)
    }

    private func waitForAntigravityExit(until deadline: DispatchTime) {
        guard !isQuitting, wantsTranslation, let pid = restartingPID else { return }
        // LaunchServices may keep this object's isTerminated false after the PID exits.
        if AntigravityRun.hasExited(pid: pid, launchedAt: desktopRun?.launchDate) {
            logRecovery("Desktop 已退出，准备重新启动")
            restartingPID = nil
            launchAntigravity()
            return
        }
        guard DispatchTime.now() < deadline else {
            logRecovery("等待 Desktop 退出超时")
            restartingPID = nil
            desktopRun?.restartFailure = "Antigravity 仍在运行 · 可在菜单中重试"
            refreshStatus()
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            self?.waitForAntigravityExit(until: deadline)
        }
    }

    private struct LaunchReply: Decodable {
        let launched: Bool
        let message: String
    }

    private func logRecovery(_ message: String) {
        try? runnerLog?.write(contentsOf: Data("[Desktop] \(message)\n".utf8))
    }

    @objc private func launchAntigravity() {
        guard canLaunchAntigravity else { return }
        launching = true
        launchNotice = nil
        if runner?.isRunning != true { startRunner() }
        refreshStatus()
        waitForLaunchRunner(until: Date().addingTimeInterval(5))
    }

    private func waitForLaunchRunner(until deadline: Date) {
        guard !isQuitting, wantsTranslation, !stopping else {
            launching = false
            refreshStatus()
            return
        }
        guard runner?.isRunning == true else {
            finishLaunch(message: lastError ?? "汉化助手未能启动，请先恢复汉化后重试。", failed: true)
            return
        }
        if FileManager.default.fileExists(atPath: supportFolder.appendingPathComponent("helper.sock").path) {
            runLaunchCommand()
            return
        }
        guard Date() < deadline else {
            finishLaunch(message: "等待汉化助手启动超时，请重新加载助手后重试。", failed: true)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            self?.waitForLaunchRunner(until: deadline)
        }
    }

    private func runLaunchCommand() {
        guard let node = nodeExecutable() else {
            finishLaunch(message: "未找到 Node.js 22 或更新版本，打开说明查看运行要求。", failed: true)
            return
        }
        let process = Process()
        let output = Pipe(), errors = Pipe()
        process.executableURL = node
        process.arguments = [runtimeFolder.appendingPathComponent("runner.mjs").path, "--launch"]
        process.currentDirectoryURL = runtimeFolder
        process.standardOutput = output
        process.standardError = errors
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try process.run()
                // The CLI returns one JSON reply, or a short error on stderr.
                let data = output.fileHandleForReading.readDataToEndOfFile()
                let errorData = errors.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                let errorText = String(data: errorData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                DispatchQueue.main.async {
                    if process.terminationStatus != 0 {
                        self.finishLaunch(message: errorText.isEmpty ? "启动 Antigravity 失败。" : errorText, failed: true)
                    } else if let reply = try? JSONDecoder().decode(LaunchReply.self, from: data) {
                        self.logRecovery(reply.launched ? "已启动汉化 Desktop" : "本次没有启动新 Desktop：\(reply.message)")
                        self.finishLaunch(message: reply.message, failed: false)
                    } else {
                        self.finishLaunch(message: "无法读取 Antigravity 启动结果。", failed: true)
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.finishLaunch(message: "启动失败：\(error.localizedDescription)", failed: true)
                }
            }
        }
    }

    private func finishLaunch(message: String?, failed: Bool) {
        launching = false
        if failed, let message { logRecovery("启动失败：\(message)") }
        if !failed, let message, !message.isEmpty {
            launchNotice = (message, runningAntigravity()?.processIdentifier)
        }
        refreshStatus()
        guard failed, !isQuitting, let message = message, !message.isEmpty else { return }
        let alert = NSAlert()
        alert.messageText = "无法启动 Antigravity"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "好")
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    @objc private func reloadTranslations() {
        guard !stopping else { return }
        guard wantsTranslation else { return }
        guard runner?.isRunning == true else {
            startRunner()
            return
        }
        guard let node = nodeExecutable() else { return }
        let process = Process()
        process.executableURL = node
        process.arguments = [runtimeFolder.appendingPathComponent("runner.mjs").path, "--reload"]
        process.currentDirectoryURL = runtimeFolder
        process.standardOutput = runnerLog
        process.standardError = runnerLog
        do {
            try process.run()
            statusLine.title = "正在重新加载词库…"
        } catch {
            lastError = "重新加载失败：\(error.localizedDescription)"
            refreshStatus()
        }
    }

    @objc private func toggleTranslation() {
        guard !stopping, !launching, restartingPID == nil else { return }
        wantsTranslation.toggle()
        if wantsTranslation {
            startRunner()
        } else {
            stopRunner { self.refreshStatus() }
        }
    }

    @objc private func openTranslations() {
        NSWorkspace.shared.open(runtimeFolder.appendingPathComponent("translations.json"))
    }

    @objc private func openReadme() {
        NSWorkspace.shared.open(homeFolder.appendingPathComponent("README.md"))
    }

    @objc private func quitHelper() {
        NSApp.terminate(nil)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if isQuitting { return .terminateNow }
        isQuitting = true
        wantsTranslation = false
        timer?.invalidate()
        guard runner?.isRunning == true else { return .terminateNow }
        stopRunner { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
}

@main
enum HelperApplication {
    static func main() {
        if CommandLine.arguments.contains("--watch-antigravity") {
            let watcher = AppWatcher()
            withExtendedLifetime(watcher) { watcher.run() }
            return
        }
        let application = NSApplication.shared
        let delegate = HelperDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}

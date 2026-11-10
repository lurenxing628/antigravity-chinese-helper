import AppKit
import Darwin
import Foundation

final class HelperDelegate: NSObject, NSApplicationDelegate, NSMenuItemValidation {
    private var statusItem: NSStatusItem!
    private let statusLine = NSMenuItem(title: "正在启动汉化…", action: nil, keyEquivalent: "")
    private let toggleItem = NSMenuItem(title: "暂停汉化并恢复英文", action: #selector(toggleTranslation), keyEquivalent: "")
    private let launchItem = NSMenuItem(title: "通过助手启动 Antigravity", action: #selector(launchAntigravity), keyEquivalent: "")
    private var runner: Process?
    private var runnerLog: FileHandle?
    private var timer: Timer?
    private var wantsTranslation = true
    private var isQuitting = false
    private var stopping = false
    private var launching = false
    private var lastError: String?
    private let shutdownGracePeriod: TimeInterval = 10

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
        menu.addItem(NSMenuItem.separator())
        launchItem.target = self
        menu.addItem(launchItem)
        menu.addItem(item("重新加载词库", action: #selector(reloadTranslations)))
        toggleItem.target = self
        menu.addItem(toggleItem)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(item("打开中文词库", action: #selector(openTranslations)))
        menu.addItem(item("打开使用说明", action: #selector(openReadme)))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(item("退出并恢复英文", action: #selector(quitHelper)))
        statusItem.menu = menu

        startRunner()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.refreshStatus()
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard let menu = statusItem?.menu else { return false }
        sender.activate(ignoringOtherApps: true)
        // Reopening the app also exposes its controls when the status item is
        // outside the visible menu bar. Reuse the same menu and actions.
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
            return wantsTranslation && !stopping && !isQuitting && !launching
        }
        return menuItem.isEnabled
    }

    private func nodeExecutable() -> URL? {
        NodeRuntime.executable(workingDirectory: runtimeFolder)
    }

    private func startRunner() {
        guard runner?.isRunning != true, !stopping, !isQuitting else { return }
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
            process.terminationHandler = { [weak self] finished in
                DispatchQueue.main.async {
                    guard let self = self, self.runner === finished else { return }
                    self.runner = nil
                    try? self.runnerLog?.close()
                    self.runnerLog = nil
                    if self.wantsTranslation && !self.isQuitting && !self.stopping {
                        self.lastError = "运行已结束（\(finished.terminationStatus)），点“重新加载词库”重试"
                    }
                    self.refreshStatus()
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
        toggleItem.isEnabled = !stopping && !launching
        launchItem.title = launching ? "正在启动 Antigravity…" : "通过助手启动 Antigravity"
        launchItem.isEnabled = wantsTranslation && !stopping && !isQuitting && !launching
        if stopping { return }
        if !wantsTranslation {
            statusLine.title = "已暂停 · 英文界面"
            return
        }
        if launching {
            statusLine.title = "正在通过助手启动 Antigravity…"
            return
        }
        if let error = lastError {
            statusLine.title = error
            return
        }
        guard runner?.isRunning == true else {
            statusLine.title = "汉化助手尚未运行"
            return
        }
        let path = supportFolder.appendingPathComponent("status.json")
        guard let data = try? Data(contentsOf: path),
              let value = try? JSONDecoder().decode(RunnerStatus.self, from: data) else {
            statusLine.title = "正在连接 Antigravity…"
            return
        }
        statusLine.title = value.menuTitle
    }

    private struct LaunchReply: Decodable {
        let launched: Bool
        let message: String
    }

    @objc private func launchAntigravity() {
        guard wantsTranslation, !stopping, !isQuitting, !launching else { return }
        launching = true
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
                        self.finishLaunch(message: reply.launched ? nil : reply.message, failed: false)
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
        refreshStatus()
        guard !isQuitting, let message = message, !message.isEmpty else { return }
        let alert = NSAlert()
        alert.messageText = failed ? "无法启动 Antigravity" : "Antigravity 启动提示"
        alert.informativeText = message
        alert.alertStyle = failed ? .warning : .informational
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
        guard !stopping else { return }
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

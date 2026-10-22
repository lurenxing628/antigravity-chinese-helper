import AppKit
import Darwin
import Foundation

final class HelperDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let statusLine = NSMenuItem(title: "正在启动汉化…", action: nil, keyEquivalent: "")
    private let toggleItem = NSMenuItem(title: "暂停汉化并恢复英文", action: #selector(toggleTranslation), keyEquivalent: "")
    private var runner: Process?
    private var runnerLog: FileHandle?
    private var timer: Timer?
    private var wantsTranslation = true
    private var isQuitting = false
    private var stopping = false
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

    private func item(_ title: String, action: Selector) -> NSMenuItem {
        let result = NSMenuItem(title: title, action: action, keyEquivalent: "")
        result.target = self
        return result
    }

    private func nodeExecutable() -> URL? {
        let userHome = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [
            userHome + "/.local/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node"
        ]
        return candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }).map(URL.init(fileURLWithPath:))
    }

    private func startRunner() {
        guard runner == nil, !stopping, !isQuitting else { return }
        guard let node = nodeExecutable() else {
            lastError = "未找到 Node.js，打开说明查看运行要求"
            refreshStatus()
            return
        }
        let script = runtimeFolder.appendingPathComponent("runner.mjs")
        guard FileManager.default.fileExists(atPath: script.path) else {
            lastError = "请先运行“安装汉化助手.command”安装运行文件"
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
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil)
            }
            runnerLog = try FileHandle(forWritingTo: logURL)
            try runnerLog?.seekToEnd()
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
        toggleItem.isEnabled = !stopping
        if stopping { return }
        if !wantsTranslation {
            statusLine.title = "已暂停 · 英文界面"
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
        let application = NSApplication.shared
        let delegate = HelperDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}

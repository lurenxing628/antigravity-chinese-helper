import AppKit
import Foundation

/// Only a new Antigravity process may launch the helper. Quitting the helper
/// during that process's lifetime must not cause it to be opened again.
struct AntigravityLaunchState {
    static let bundleIdentifier = "com.google.antigravity"
    private var handledProcesses = Set<pid_t>()

    mutating func shouldOpenHelper(bundleIdentifier: String?, processIdentifier: pid_t) -> Bool {
        guard bundleIdentifier == Self.bundleIdentifier else { return false }
        return handledProcesses.insert(processIdentifier).inserted
    }

    mutating func applicationTerminated(bundleIdentifier: String?, processIdentifier: pid_t) {
        guard bundleIdentifier == Self.bundleIdentifier else { return }
        handledProcesses.remove(processIdentifier)
    }
}

/// A login LaunchAgent runs this mode without starting NSApplication or Node.
/// All translation and reconnect work stays in the normal helper application.
final class AppWatcher {
    private let workspace = NSWorkspace.shared
    private var launchState = AntigravityLaunchState()
    private var observers: [NSObjectProtocol] = []
    private var openingHelper = false

    func run() {
        let center = workspace.notificationCenter
        observers.append(center.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] notification in
            guard let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.applicationStarted(application)
        })
        observers.append(center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] notification in
            guard let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.launchState.applicationTerminated(bundleIdentifier: application.bundleIdentifier, processIdentifier: application.processIdentifier)
        })

        // Subscribe first so an app starting during this initial snapshot is
        // handled once, whether it appears here or arrives as a notification.
        for application in workspace.runningApplications {
            applicationStarted(application)
        }
        RunLoop.main.run()
    }

    private func applicationStarted(_ application: NSRunningApplication) {
        guard !application.isTerminated,
              launchState.shouldOpenHelper(bundleIdentifier: application.bundleIdentifier, processIdentifier: application.processIdentifier),
              !openingHelper else { return }

        let watcherPID = ProcessInfo.processInfo.processIdentifier
        let helperIsRunning = workspace.runningApplications.contains {
            $0.bundleIdentifier == "local.antigravity.chinese-helper"
                && $0.processIdentifier != watcherPID && !$0.isTerminated
        }
        guard !helperIsRunning else { return }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        // The observer uses the helper's executable. Do not let LaunchServices
        // reuse this background process when opening the menu bar application.
        configuration.createsNewApplicationInstance = true
        openingHelper = true
        workspace.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { [weak self] _, error in
            DispatchQueue.main.async {
                self?.openingHelper = false
                if let error = error {
                    NSLog("自动启动 Antigravity 汉化助手失败：%@", error.localizedDescription)
                }
            }
        }
    }
}

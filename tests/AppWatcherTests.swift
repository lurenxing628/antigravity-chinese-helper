import Foundation

@main
struct AppWatcherTests {
    static func main() {
        var state = AntigravityLaunchState()
        let target = AntigravityLaunchState.bundleIdentifier

        precondition(!state.shouldOpenHelper(bundleIdentifier: "com.example.other", processIdentifier: 100), "Other apps must not start the helper")
        precondition(state.shouldOpenHelper(bundleIdentifier: target, processIdentifier: 100), "An already running Antigravity must start the helper on observer startup")
        precondition(!state.shouldOpenHelper(bundleIdentifier: target, processIdentifier: 100), "A duplicate startup event must not reopen a manually quit helper")

        state.applicationTerminated(bundleIdentifier: "local.antigravity.chinese-helper", processIdentifier: 100)
        precondition(!state.shouldOpenHelper(bundleIdentifier: target, processIdentifier: 100), "Quitting the helper must not reset the current Antigravity session")

        precondition(state.shouldOpenHelper(bundleIdentifier: target, processIdentifier: 101), "A new Antigravity process must be allowed to start the helper")
        state.applicationTerminated(bundleIdentifier: target, processIdentifier: 100)
        precondition(state.shouldOpenHelper(bundleIdentifier: target, processIdentifier: 100), "A PID reused after Antigravity exits must be treated as a new session")

        print("AppWatcher: startup, unrelated apps, manual exit, and new sessions passed")
    }
}

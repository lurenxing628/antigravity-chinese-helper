import Darwin
import Foundation

struct RunnerStatus: Decodable {
    let status: String
    let translatedWindows: Int
    let lastError: String?
    let pid: pid_t?
    let state: String?
    let discoveredAt: String?
    let nativeChineseTitles: Bool?

    var titleModeDescription: String? {
        guard status == "running" || status == "waiting" else { return nil }
        switch nativeChineseTitles {
        case true:
            return "会话标题 · 直接生成中文"
        case false:
            return state == "connected" && translatedWindows > 0
                ? "会话标题 · 由主窗口自动改为中文"
                : "会话标题 · 等待主窗口连接"
        default:
            return "会话标题 · 等待确认后端状态"
        }
    }

    private static let discoveryDateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    var isWaitingForApp: Bool {
        status == "waiting" && state == "waiting-for-app"
    }

    func discoveryDate(since launchDate: Date, now: Date) -> Date? {
        guard let discoveredAt,
              let date = Self.discoveryDateFormatter.date(from: discoveredAt),
              date >= launchDate, (0...10).contains(now.timeIntervalSince(date)) else { return nil }
        return date
    }

    var menuTitle: String {
        if status == "error" {
            return "汉化遇到问题：" + (lastError ?? "打开说明查看日志")
        }
        if status == "stopped" {
            return "汉化助手已停止"
        }
        if translatedWindows > 0 {
            return "已汉化 \(translatedWindows) 个窗口"
        }
        if status == "waiting" || status == "running" {
            return "运行中 · 等待 Antigravity 窗口"
        }
        return "汉化运行中"
    }
}

struct AntigravityRun {
    let pid: pid_t
    let launchDate: Date
    let debugPortRequested: Bool?
    var restartFailure: String?

    func needsAutomaticRestart(status: RunnerStatus, now: Date) -> Bool {
        guard restartFailure == nil, debugPortRequested == false, status.isWaitingForApp,
              let discovery = status.discoveryDate(since: launchDate, now: now) else { return false }
        return discovery.timeIntervalSince(launchDate) >= 5
    }

    // LaunchServices can omit launchDate for Desktop processes started from an executable.
    static func launchDate(of pid: pid_t) -> Date? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return Date(timeIntervalSince1970: Double(info.pbi_start_tvsec) + Double(info.pbi_start_tvusec) / 1_000_000)
    }

    static func hasExited(pid: pid_t, launchedAt: Date?) -> Bool {
        if let launchedAt, let current = launchDate(of: pid) { return current != launchedAt }
        return kill(pid, 0) == -1 && errno == ESRCH
    }

    // Read argv for this Desktop process. A leftover port file can belong to a previous run.
    static func debugPortRequested(by pid: pid_t) -> Bool? {
        var mib: [CInt] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<CInt>.size else { return nil }
        var bytes = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &bytes, &size, nil, 0) == 0, size > MemoryLayout<CInt>.size else { return nil }
        let argc = bytes.withUnsafeBytes { $0.loadUnaligned(as: CInt.self) }
        // The kernel prefixes argv with the executable path and NUL padding.
        guard argc > 0, let pathEnd = bytes[MemoryLayout<CInt>.size..<size].firstIndex(of: 0),
              var start = bytes[pathEnd..<size].firstIndex(where: { $0 != 0 }) else { return nil }
        for _ in 0..<argc {
            guard let end = bytes[start..<size].firstIndex(of: 0) else { return nil }
            let argument = String(decoding: bytes[start..<end], as: UTF8.self)
            if argument == "--" { break }
            if argument == "--remote-debugging-port" || argument.hasPrefix("--remote-debugging-port=") { return true }
            start = end + 1
        }
        return false
    }
}

import Foundation

struct RunnerStatus: Decodable {
    let status: String
    let translatedWindows: Int
    let lastError: String?

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

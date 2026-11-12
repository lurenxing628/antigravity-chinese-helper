import Foundation

struct RunnerStatus: Decodable {
    let status: String
    let translatedWindows: Int
    let lastError: String?
    let subagentContext: SubagentContext?

    struct SubagentContext: Decodable {
        let targetTokens: Int?
        let active: Bool
        let error: String?
        let message: String
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

    var subagentMenuTitle: String {
        if status == "stopped" { return "子代理覆盖已停止" }
        guard let context = subagentContext else { return "正在读取子代理覆盖状态…" }
        if let error = context.error { return "子代理覆盖遇到问题：\(error)" }
        if let tokens = context.targetTokens, context.active {
            return "子代理上下文已生效：\(tokens) token"
        }
        return "子代理上下文：\(context.message)"
    }
}

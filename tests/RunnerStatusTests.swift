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

        print("RunnerStatus：\(cases.count) 个汉化状态场景和 \(invalidStatuses.count) 个必填字段检查通过")
    }
}

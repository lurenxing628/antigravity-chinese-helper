import Foundation

@main
struct RunnerStatusTests {
    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    static func main() throws {
        let cases: [(name: String, json: String, translation: String, subagent: String)] = [
            (
                "汉化错误不掩盖已生效的子代理覆盖",
                #"{"status":"error","translatedWindows":1,"lastError":"词库重新加载失败","subagentContext":{"targetTokens":64000,"active":true,"error":null,"message":""}}"#,
                "汉化遇到问题：词库重新加载失败",
                "子代理上下文已生效：64000 token"
            ),
            (
                "汉化窗口数与默认子代理上下文",
                #"{"status":"running","translatedWindows":2,"lastError":null,"subagentContext":{"targetTokens":null,"active":false,"error":null,"message":"使用子代理默认上下文"}}"#,
                "已汉化 2 个窗口",
                "子代理上下文：使用子代理默认上下文"
            ),
            (
                "无窗口且覆盖等待下次启动",
                #"{"status":"waiting","translatedWindows":0,"lastError":null,"subagentContext":{"targetTokens":64000,"active":false,"error":null,"message":"已保存。正常退出 Antigravity 后，点击“Antigravity 汉化助手”图标启动。"}}"#,
                "运行中 · 等待 Antigravity 窗口",
                "子代理上下文：已保存。正常退出 Antigravity 后，点击“Antigravity 汉化助手”图标启动。"
            ),
            (
                "已连接但没有主窗口",
                #"{"status":"running","translatedWindows":0,"lastError":null,"subagentContext":{"targetTokens":64000,"active":true,"error":null,"message":""}}"#,
                "运行中 · 等待 Antigravity 窗口",
                "子代理上下文已生效：64000 token"
            ),
            (
                "子代理覆盖失败不影响汉化状态",
                #"{"status":"running","translatedWindows":1,"lastError":null,"subagentContext":{"targetTokens":64000,"active":false,"error":"助手后端已断开","message":"已保存。正常退出 Antigravity 后，点击“Antigravity 汉化助手”图标启动。"}}"#,
                "已汉化 1 个窗口",
                "子代理覆盖遇到问题：助手后端已断开"
            ),
            (
                "启动早期尚无后端状态",
                #"{"status":"waiting","translatedWindows":0,"lastError":null,"subagentContext":null}"#,
                "运行中 · 等待 Antigravity 窗口",
                "正在读取子代理覆盖状态…"
            ),
            (
                "停止后不展示旧覆盖状态",
                #"{"status":"stopped","translatedWindows":0,"lastError":null,"subagentContext":{"targetTokens":64000,"active":false,"error":null,"message":"已保存。正常退出 Antigravity 后，点击“Antigravity 汉化助手”图标启动。"}}"#,
                "汉化助手已停止",
                "子代理覆盖已停止"
            ),
        ]

        let decoder = JSONDecoder()
        for test in cases {
            let value = try decoder.decode(RunnerStatus.self, from: Data(test.json.utf8))
            guard value.menuTitle == test.translation, value.subagentMenuTitle == test.subagent else {
                throw Failure(description: "\(test.name)：得到 \(value.menuTitle)；\(value.subagentMenuTitle)")
            }
        }

        let invalidStatuses = [
            #"{"state":"running","windows":2,"message":"旧格式错误"}"#,
            #"{"status":"running","translatedWindows":1,"lastError":null,"subagentContext":{"targetTokens":64000,"error":null,"message":""}}"#,
            #"{"status":"running","translatedWindows":1,"lastError":null,"subagentContext":{"targetTokens":64000,"active":true,"error":null}}"#,
        ]
        for json in invalidStatuses {
            do {
                _ = try decoder.decode(RunnerStatus.self, from: Data(json.utf8))
                throw Failure(description: "缺少 runner 必填字段时不能补默认状态")
            } catch is DecodingError {
                // 仅接受 runner 现有字段契约，不为残缺负载补默认值。
            }
        }

        print("RunnerStatus：\(cases.count) 个双状态场景和 \(invalidStatuses.count) 个必填字段检查通过")
    }
}

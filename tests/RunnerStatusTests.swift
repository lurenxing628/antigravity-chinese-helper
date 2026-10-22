import Foundation

@main
struct RunnerStatusTests {
    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    static func main() throws {
        let cases: [(name: String, json: String, expected: String)] = [
            (
                "runner error details",
                #"{"running":true,"pid":123,"status":"error","state":"connected","translatedWindows":1,"connectedWindows":1,"rendererVersion":"0.3.4","dictionaryLoadedAt":null,"lastError":"dictionary-reload-failed"}"#,
                "汉化遇到问题：dictionary-reload-failed"
            ),
            (
                "translated window count",
                #"{"status":"running","translatedWindows":2,"lastError":null}"#,
                "已汉化 2 个窗口"
            ),
            (
                "waiting without windows",
                #"{"status":"waiting","translatedWindows":0,"lastError":null}"#,
                "运行中 · 等待 Antigravity 窗口"
            ),
            (
                "running without windows",
                #"{"status":"running","translatedWindows":0,"lastError":null}"#,
                "运行中 · 等待 Antigravity 窗口"
            ),
            (
                "missing optional error",
                #"{"status":"error","translatedWindows":0}"#,
                "汉化遇到问题：打开说明查看日志"
            ),
            (
                "stopped",
                #"{"status":"stopped","translatedWindows":0,"lastError":null}"#,
                "汉化助手已停止"
            ),
        ]

        let decoder = JSONDecoder()
        for test in cases {
            let value = try decoder.decode(RunnerStatus.self, from: Data(test.json.utf8))
            guard value.menuTitle == test.expected else {
                throw Failure(description: "\(test.name): expected \(test.expected), got \(value.menuTitle)")
            }
        }

        let legacyStatus = Data(#"{"state":"running","windows":2,"message":"legacy error"}"#.utf8)
        do {
            _ = try decoder.decode(RunnerStatus.self, from: legacyStatus)
            throw Failure(description: "legacy fields must not replace runner status fields")
        } catch is DecodingError {
            // Required fields must come from the runner's current JSON contract.
        }

        print("RunnerStatus: \(cases.count) status cases and strict field decoding passed")
    }
}

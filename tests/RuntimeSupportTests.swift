import Foundation

@main
struct RuntimeSupportTests {
    struct Failure: Error, CustomStringConvertible { let description: String }

    static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw Failure(description: message) }
    }

    static func main() throws {
        let files = FileManager.default
        let home = files.temporaryDirectory.resolvingSymlinksInPath().appendingPathComponent("helper-runtime-\(UUID().uuidString)")
        try files.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? files.removeItem(at: home) }
        let environment = ["HOME": home.path, "PATH": "/usr/bin:/bin"]
        func node(_ relativePath: String, version: String, body: String? = nil) throws -> URL {
            let url = home.appendingPathComponent(relativePath)
            try files.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try ("#!/bin/sh\n" + (body ?? "printf '%s\\n' '\(version)'\n")).write(to: url, atomically: false, encoding: .utf8)
            try files.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
            return url
        }
        let explicit = try node("chosen/node", version: "v22.11.0")
        let old = try node(".local/bin/node", version: "v20.10.0")
        let nvmDefault = try node(".nvm/versions/node/v22.10.0/bin/node", version: "v22.10.0")
        let nvmNewest = try node(".nvm/versions/node/v24.1.0/bin/node", version: "v24.1.0")
        try files.createDirectory(at: home.appendingPathComponent(".nvm/alias"), withIntermediateDirectories: true)
        try "work\n".write(to: home.appendingPathComponent(".nvm/alias/default"), atomically: false, encoding: .utf8)
        try "22\n".write(to: home.appendingPathComponent(".nvm/alias/work"), atomically: false, encoding: .utf8)
        var configured = environment
        configured["ANTIGRAVITY_HELPER_NODE"] = explicit.path
        try expect(NodeRuntime.executable(home: home, environment: configured, workingDirectory: home) == explicit,
                   "explicit Node path must take priority")
        try expect(NodeRuntime.executable(home: home, environment: environment, workingDirectory: home)?.resolvingSymlinksInPath() == nvmDefault.resolvingSymlinksInPath(),
                   "skip Node 20 and respect nvm default alias over a higher installed version")

        let fnm = home.appendingPathComponent("Library/Application Support/fnm")
        let fnmNode = try node("Library/Application Support/fnm/node-versions/v23.2.0/installation/bin/node", version: "v23.2.0")
        try files.createDirectory(at: fnm.appendingPathComponent("aliases"), withIntermediateDirectories: true)
        try files.createSymbolicLink(at: fnm.appendingPathComponent("aliases/default"), withDestinationURL: fnmNode.deletingLastPathComponent().deletingLastPathComponent())
        try files.removeItem(at: home.appendingPathComponent(".nvm/alias/default"))
        try expect(NodeRuntime.executable(home: home, environment: environment, workingDirectory: home)?.resolvingSymlinksInPath() == fnmNode.resolvingSymlinksInPath(),
                   "fnm macOS default alias must resolve its installation/bin/node")

        try files.removeItem(at: fnm.appendingPathComponent("aliases/default"))
        let miseNode = try node(".local/share/mise/installs/node/22.9.0/bin/node", version: "v22.9.0")
        let candidates = NodeRuntime.candidates(home: home, environment: environment).map { $0.resolvingSymlinksInPath() }.filter {
            $0.resolvingSymlinksInPath().path.hasPrefix(home.path) && $0.resolvingSymlinksInPath().path != old.path
        }
        try expect(candidates.firstIndex(of: nvmNewest)! < candidates.firstIndex(of: fnmNode)!, "fallback uses descending major version")
        try expect(candidates.firstIndex(of: nvmDefault)! < candidates.firstIndex(of: miseNode)!, "fallback uses numeric minor version order")
        try expect(NodeRuntime.validatedExecutable(in: candidates, environment: environment, workingDirectory: home)?.resolvingSymlinksInPath() == nvmNewest.resolvingSymlinksInPath(),
                   "fallback finds the highest installed compatible version")

        try Data().write(to: home.appendingPathComponent("working-directory-marker"))
        let shim = try node(".local/share/mise/shims/node", version: "", body: "[ -f ./working-directory-marker ] && [ \"$MISE_NOT_FOUND_AUTO_INSTALL\" = false ] && printf 'v22.12.0\\n'\n")
        try expect(NodeRuntime.executable(home: home, environment: environment, workingDirectory: home) == shim,
                   "mise shim runs in the runtime working directory without auto-installing")
        let hung = try node("hung/node", version: "", body: "exec /bin/sleep 10\n")
        let start = Date()
        try expect(NodeRuntime.validatedExecutable(in: [hung, old, explicit], environment: environment, workingDirectory: home) == explicit,
                   "skip hung and old candidates")
        try expect(Date().timeIntervalSince(start) < 3, "a hung shim must not block discovery")

        let log = home.appendingPathComponent("helper.log")
        let original = Data("first line\n".utf8)
        try original.write(to: log)
        let small = try HelperLog.open(at: log)
        try small.write(contentsOf: Data("next line\n".utf8))
        try small.close()
        let smallData = try Data(contentsOf: log)
        try expect(smallData == Data("first line\nnext line\n".utf8), "small logs are preserved and appended")
        let lines = (0..<12000).map { "line \($0): 汉化日志 " + String(repeating: "x", count: 48) + "\n" }.joined()
        try Data(lines.utf8).write(to: log)
        let large = try HelperLog.open(at: log)
        try large.write(contentsOf: Data("appended\n".utf8))
        try large.close()
        let retained = try Data(contentsOf: log)
        let text = String(data: retained, encoding: .utf8) ?? ""
        try expect(retained.count <= 256 * 1024 + 9, "large log keeps only the bounded tail")
        try expect(text.hasPrefix("line ") && text.hasSuffix("line 11999: 汉化日志 " + String(repeating: "x", count: 48) + "\nappended\n"),
                   "log tail starts at a complete UTF-8 line and retains the latest output")
        print("RuntimeSupport: Node selection, manager defaults, timeout and log retention passed")
    }
}

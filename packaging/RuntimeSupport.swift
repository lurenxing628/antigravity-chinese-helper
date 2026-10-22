import Darwin
import Foundation

enum NodeRuntime {
    static func executable(
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        workingDirectory: URL
    ) -> URL? {
        validatedExecutable(in: candidates(home: home, environment: environment),
                            environment: environment, workingDirectory: workingDirectory)
    }

    // Prefer the user's selected runtime before looking through installed versions.
    static func candidates(home: URL, environment: [String: String]) -> [URL] {
        func configured(_ name: String, fallback: URL) -> URL {
            environment[name].flatMap { path($0, home: home) } ?? fallback
        }
        let dataHome = configured("XDG_DATA_HOME", fallback: home.appendingPathComponent(".local/share"))
        let nvm = configured("NVM_DIR", fallback: home.appendingPathComponent(".nvm"))
        let volta = configured("VOLTA_HOME", fallback: home.appendingPathComponent(".volta"))
        let mise = configured("MISE_DATA_DIR", fallback: dataHome.appendingPathComponent("mise"))
        let fnmRoots = [
            environment["FNM_DIR"].flatMap { path($0, home: home) },
            home.appendingPathComponent("Library/Application Support/fnm"),
            dataHome.appendingPathComponent("fnm"),
        ].compactMap { $0 }
        let nvmVersions = installed(in: nvm.appendingPathComponent("versions/node"), suffix: "bin/node")
        var versions = nvmVersions
        for root in fnmRoots {
            versions += installed(in: root.appendingPathComponent("node-versions"), suffix: "installation/bin/node")
        }
        versions += installed(in: volta.appendingPathComponent("tools/image/node"), suffix: "bin/node")
        let miseInstalls = configured("MISE_INSTALLS_DIR", fallback: mise.appendingPathComponent("installs"))
        versions += installed(in: miseInstalls.appendingPathComponent("node"), suffix: "bin/node")

        var result: [URL] = []
        if let explicit = environment["ANTIGRAVITY_HELPER_NODE"].flatMap({ path($0, home: home) }) {
            result.append(explicit)
        }
        result.append(home.appendingPathComponent(".local/bin/node"))
        if let bin = environment["NVM_BIN"].flatMap({ path($0, home: home) }) {
            result.append(bin.appendingPathComponent("node"))
        }
        if let multishell = environment["FNM_MULTISHELL_PATH"].flatMap({ path($0, home: home) }) {
            result.append(multishell.appendingPathComponent("bin/node"))
        }
        result += [volta.appendingPathComponent("bin/node"),
                   configured("MISE_SHIMS_DIR", fallback: mise.appendingPathComponent("shims")).appendingPathComponent("node")]
        result += nvmDefault(in: nvm, versions: nvmVersions)
        result += fnmRoots.map { $0.appendingPathComponent("aliases/default/bin/node") }
        result += (environment["PATH"] ?? "").split(separator: ":").compactMap {
            path(String($0), home: home)?.appendingPathComponent("node")
        }
        result += ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].map { URL(fileURLWithPath: $0) }
        result += versions.sorted { $1.version.lexicographicallyPrecedes($0.version) }.map(\.executable)
        var seen = Set<String>()
        // Do not resolve symlinks: mise/Volta dispatch according to the shim's name.
        return result.filter { seen.insert($0.standardizedFileURL.path).inserted }
    }

    static func validatedExecutable(in candidates: [URL], environment: [String: String], workingDirectory: URL) -> URL? {
        for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate.path) {
            let process = Process()
            let output = Pipe()
            let finished = DispatchSemaphore(value: 0)
            process.executableURL = candidate
            process.arguments = ["--version"]
            process.currentDirectoryURL = workingDirectory
            var probeEnvironment = environment
            // Runtime discovery must not make mise download a missing version.
            probeEnvironment["MISE_NOT_FOUND_AUTO_INSTALL"] = "false"
            process.environment = probeEnvironment
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { _ in finished.signal() }
            do { try process.run() } catch { continue }
            if finished.wait(timeout: .now() + 1) == .timedOut {
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
                process.waitUntilExit()
                continue
            }
            guard process.terminationStatus == 0 else { continue }
            // A failed shim can leave descendants holding stdout; never wait for their EOF.
            let descriptor = output.fileHandleForReading.fileDescriptor
            _ = fcntl(descriptor, F_SETFL, O_NONBLOCK)
            var bytes = [UInt8](repeating: 0, count: 128)
            let count = read(descriptor, &bytes, bytes.count)
            guard count > 0,
                  let value = String(bytes: bytes.prefix(count), encoding: .utf8),
                  let version = versionNumbers(value.trimmingCharacters(in: .whitespacesAndNewlines)),
                  version[0] >= 22 else { continue }
            return candidate
        }
        return nil
    }

    private struct Installation {
        let version: [Int]
        let executable: URL
    }

    private static func installed(in directory: URL, suffix: String) -> [Installation] {
        let entries = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return entries.compactMap { entry in
            guard let version = versionNumbers(entry.lastPathComponent), version.count == 3 else { return nil }
            return Installation(version: version, executable: entry.appendingPathComponent(suffix))
        }.sorted { $1.version.lexicographicallyPrecedes($0.version) }
    }

    private static func nvmDefault(in root: URL, versions: [Installation]) -> [URL] {
        var alias = "default"
        var visited = Set<String>()
        while visited.insert(alias).inserted {
            if let prefix = versionNumbers(alias) {
                return versions.filter { $0.version.starts(with: prefix) }.map(\.executable)
            }
            if alias == "node" || alias == "stable" { return versions.map(\.executable) }
            guard let value = try? String(contentsOf: root.appendingPathComponent("alias/" + alias), encoding: .utf8) else { break }
            alias = value.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return []
    }

    private static func versionNumbers(_ value: String) -> [Int]? {
        let value = value.hasPrefix("v") ? String(value.dropFirst()) : value
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...3).contains(parts.count), parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }) else { return nil }
        let numbers = parts.compactMap { Int($0) }
        return numbers.count == parts.count ? numbers : nil
    }

    private static func path(_ value: String, home: URL) -> URL? {
        if value == "~" { return home }
        if value.hasPrefix("~/") { return home.appendingPathComponent(String(value.dropFirst(2))) }
        guard value.hasPrefix("/") else { return nil }
        return URL(fileURLWithPath: value)
    }
}

enum HelperLog {
    private static let maximumSize: UInt64 = 512 * 1024
    private static let retainedSize: UInt64 = 256 * 1024

    static func open(at url: URL) throws -> FileHandle {
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        let handle = try FileHandle(forUpdating: url)
        do {
            let size = try handle.seekToEnd()
            if size > maximumSize {
                // Include the preceding byte so a boundary at a line start keeps that line.
                try handle.seek(toOffset: size - retainedSize - 1)
                let tail = try handle.read(upToCount: Int(retainedSize + 1)) ?? Data()
                let retained: Data
                if let newline = tail.firstIndex(of: 0x0a) {
                    retained = Data(tail.suffix(from: tail.index(after: newline)))
                } else {
                    // A single oversized line has no complete line in the retained window.
                    retained = Data()
                }
                try handle.truncate(atOffset: 0)
                try handle.seek(toOffset: 0)
                try handle.write(contentsOf: retained)
            }
            try handle.seekToEnd()
            return handle
        } catch {
            try? handle.close()
            throw error
        }
    }
}

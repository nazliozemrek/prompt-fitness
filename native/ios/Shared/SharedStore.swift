//
//  SharedStore.swift
//  Compiled into BOTH the App target and the Safari Extension target.
//
//  A tiny on-device mailbox in the App Group container: the Safari extension and the in-app
//  browser append numeric usage entries, the dashboard drains them into its own store.
//  Nothing leaves the device.
//  NSFileCoordinator serializes access across the two processes.
//

import Foundation

enum SharedStore {
    /// Must match the App Group capability on both targets.
    static let appGroup = "group.com.promptfitness.app"
    static let maxEntries = 3000
    static let maxTokens = 5_000_000

    private static let allowedKeys: Set<String> = ["t", "m", "i", "o", "s", "f", "src"]
    private static let sources: Set<String> = ["extension", "inapp"]
    private static let modelIds: Set<String> = [
        "gpt4o-mini", "gemini-flash", "haiku", "gpt4o", "sonnet", "gemini-pro", "opus", "o1",
    ]

    private static var fileURL: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent("extension-log.json", isDirectory: false)
    }

    /// Returns a clean copy containing only whitelisted numeric fields, or nil.
    /// This is the last line of defense: text can never be written to the shared container.
    static func sanitize(_ raw: [String: Any]) -> [String: Any]? {
        guard Set(raw.keys).isSubset(of: allowedKeys),
              let t = raw["t"] as? NSNumber, t.doubleValue > 0,
              let i = raw["i"] as? NSNumber, (0...maxTokens).contains(i.intValue),
              let o = raw["o"] as? NSNumber, (0...maxTokens).contains(o.intValue),
              let m = raw["m"] as? String, modelIds.contains(m),
              let src = raw["src"] as? String, sources.contains(src)
        else { return nil }

        var clean: [String: Any] = [
            "t": t.int64Value, "m": m, "i": i.intValue, "o": o.intValue, "src": src,
        ]
        if let s = raw["s"] as? NSNumber, (0...100).contains(s.intValue) {
            clean["s"] = s.intValue
        } else {
            clean["s"] = NSNull()
        }
        if let f = raw["f"] as? NSNumber, [0.0, 0.5, 1.0].contains(f.doubleValue) {
            clean["f"] = f.doubleValue
        } else {
            clean["f"] = NSNull()
        }
        return clean
    }

    static func append(_ raw: [String: Any]) {
        guard let entry = sanitize(raw) else { return }
        coordinatedWrite { url in
            var log = read(url)
            log.append(entry)
            write(Array(log.suffix(maxEntries)), to: url)
        }
    }

    /// Returns all pending entries and removes them from the shared container.
    static func drain() -> [[String: Any]] {
        var out: [[String: Any]] = []
        coordinatedWrite { url in
            out = read(url).compactMap(sanitize)
            try? FileManager.default.removeItem(at: url)
        }
        return out
    }

    static func clear() {
        coordinatedWrite { url in try? FileManager.default.removeItem(at: url) }
    }

    // MARK: - File helpers

    private static func coordinatedWrite(_ body: (URL) -> Void) {
        guard let url = fileURL else { return }
        var error: NSError?
        NSFileCoordinator().coordinate(writingItemAt: url, options: .forMerging, error: &error) { body($0) }
    }

    private static func read(_ url: URL) -> [[String: Any]] {
        guard let data = try? Data(contentsOf: url),
              let array = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        else { return [] }
        return array
    }

    private static func write(_ log: [[String: Any]], to url: URL) {
        guard let data = try? JSONSerialization.data(withJSONObject: log) else { return }
        #if os(iOS)
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try? data.write(to: url, options: [.atomic])
        #endif
    }
}

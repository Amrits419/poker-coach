import Foundation
import ScreenCaptureKit
import CoreGraphics

/// Which window to read.
enum Target: String, CaseIterable {
    case auto = "Any poker table (auto)"
    case clubgg = "ClubGG"
    case pokernow = "PokerNow (browser)"
    case other = "Other poker apps"

    static let pokerApps = ["clubgg", "pokerstars", "ggpoker", "natural8", "wpt global", "wptglobal", "acr", "americas cardroom",
                            "ignition", "bovada", "partypoker", "888poker", "clubwpt", "pppoker", "pokerbros", "x-poker", "upoker"]

    func matches(app: String, bundle: String, title: String) -> Int? {
        let a = (app + " " + bundle).lowercased(), t = title.lowercased()
        let isPokerNow = t.contains("poker now") || t.contains("pokernow")
        let isClub = a.contains("clubgg")
        let isOther = Target.pokerApps.contains { a.contains($0) } && !isClub
        switch self {
        case .clubgg: return isClub ? 3 : nil
        case .pokernow: return isPokerNow ? 3 : nil
        case .other: return isOther ? 2 : nil
        case .auto: return isClub ? 3 : isPokerNow ? 2 : isOther ? 1 : nil
        }
    }
}

/// Reads the poker table window while a session runs and appends what it sees to a text
/// log (table.jsonl). No image is written to disk. Nothing is shown during the session.
@MainActor
final class Recorder {
    private(set) var sessionDir: URL?
    private(set) var linesWritten = 0
    private(set) var startedAt: Date?
    private(set) var windowName: String?
    var target: Target = .auto
    var onChange: (() -> Void)?

    private var timer: Timer?
    private var filter: SCContentFilter?
    private var config: SCStreamConfiguration?
    private var lastThumb: [UInt8]?
    private var lastKept = Date.distantPast
    private var busy = false
    private var lastLookup = Date.distantPast
    private var log: FileHandle?

    nonisolated static let root: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("PokerRecorder/sessions", isDirectory: true)

    var isRecording: Bool { timer != nil }

    func start(fps: Double = 2) throws {
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let dir = Recorder.root.appendingPathComponent(stamp, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("table.jsonl")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        log = try FileHandle(forWritingTo: url)
        let meta = ["target": target.rawValue, "started": ISO8601DateFormatter().string(from: Date())]
        try? JSONSerialization.data(withJSONObject: meta).write(to: dir.appendingPathComponent("session.json"))
        sessionDir = dir; linesWritten = 0; startedAt = Date(); lastThumb = nil; filter = nil; windowName = nil
        timer = Timer.scheduledTimer(withTimeInterval: 1 / fps, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.tick() }
        }
        onChange?()
    }

    func stop() -> URL? {
        timer?.invalidate(); timer = nil
        try? log?.close(); log = nil
        onChange?()
        return sessionDir
    }

    private func lookupWindow() async {
        lastLookup = Date()
        guard let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) else { return }
        let scored = content.windows.compactMap { w -> (SCWindow, Int)? in
            guard w.frame.width > 300, w.frame.height > 250 else { return nil }
            let s = target.matches(app: w.owningApplication?.applicationName ?? "", bundle: w.owningApplication?.bundleIdentifier ?? "", title: w.title ?? "")
            return s.map { (w, $0) }
        }
        guard let win = scored.max(by: { ($0.1, $0.0.frame.width * $0.0.frame.height) < ($1.1, $1.0.frame.width * $1.0.frame.height) })?.0 else {
            filter = nil; windowName = nil; onChange?(); return
        }
        let cfg = SCStreamConfiguration()
        let scale = win.frame.width > 1200 ? 1.0 : 2.0   // enough pixels for small text without huge frames
        cfg.width = Int(win.frame.width * scale); cfg.height = Int(win.frame.height * scale)
        cfg.showsCursor = false
        filter = SCContentFilter(desktopIndependentWindow: win)
        config = cfg
        windowName = [win.owningApplication?.applicationName, win.title].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " – ")
        onChange?()
    }

    private func tick() async {
        guard !busy, log != nil else { return }
        busy = true; defer { busy = false }
        if filter == nil || Date().timeIntervalSince(lastLookup) > 10 { await lookupWindow() }
        guard let filter, let config else { return }
        guard let image = try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) else {
            self.filter = nil; return
        }
        let thumb = Recorder.thumbnail(image)
        let changed = lastThumb.map { Recorder.diff($0, thumb) > 1.5 } ?? true
        guard changed || Date().timeIntervalSince(lastKept) > 10 else { return }
        lastThumb = thumb; lastKept = Date()
        let t = Int(Date().timeIntervalSince1970 * 1000)
        // Read off the main thread; the image is dropped as soon as it has been read
        let line: Data? = await Task.detached(priority: .utility) {
            let r = TableReader.read(image)
            struct Line: Encodable { let t: Int; let w: Int; let h: Int; let boxes: [TableReader.Box]; let cards: [TableReader.Card] }
            guard var d = try? JSONEncoder().encode(Line(t: t, w: image.width, h: image.height, boxes: r.boxes, cards: r.cards)) else { return nil }
            d.append(0x0a)
            return d
        }.value
        guard let line, let log else { return }
        log.write(line)
        linesWritten += 1
        onChange?()
    }

    static func thumbnail(_ image: CGImage) -> [UInt8] {
        let n = 48
        var px = [UInt8](repeating: 0, count: n * n)
        px.withUnsafeMutableBytes { buf in
            CGContext(data: buf.baseAddress, width: n, height: n, bitsPerComponent: 8, bytesPerRow: n,
                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)?
                .draw(image, in: CGRect(x: 0, y: 0, width: n, height: n))
        }
        return px
    }

    static func diff(_ a: [UInt8], _ b: [UInt8]) -> Double {
        var total = 0
        for i in 0..<min(a.count, b.count) { total += abs(Int(a[i]) - Int(b[i])) }
        return Double(total) / Double(a.count)
    }
}

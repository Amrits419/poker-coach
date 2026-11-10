import AppKit
import Foundation
import ImageIO

// Poker Recorder: a menu-bar app.
// Start → reads the poker table window whenever it changes and appends what it sees to a
//         text log. No screenshots are kept, and nothing is shown while you play.
// End   → opens the session report in Poker Coach. For PokerNow, if you downloaded the
//         game log during the session, that exact log is used instead of screen reading.
//
// CLI (testing): pokerrec read <image.png|jpg>   prints what the reader sees in one image

let reportBase = ProcessInfo.processInfo.environment["POKER_COACH_URL"] ?? "http://localhost:5173"

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let recorder = Recorder()
    var item: NSStatusItem!
    var status = "Getting ready…"
    var lastSession: URL?
    var ready = false

    func applicationDidFinishLaunching(_ note: Notification) {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        recorder.onChange = { [weak self] in self?.refresh() }
        if let saved = UserDefaults.standard.string(forKey: "target"), let t = Target(rawValue: saved) { recorder.target = t }
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in if self?.recorder.isRecording == true { self?.refresh() } }
        }
        refresh()
        // Load Apple Vision's text models now so the first hands of a session aren't missed
        Task.detached(priority: .utility) {
            TableReader.warmUp()
            await MainActor.run {
                self.ready = true; self.status = "Ready"; self.refresh()
                if CommandLine.arguments.contains("--start") { self.start() }
            }
        }
    }

    func refresh() {
        if recorder.isRecording, let start = recorder.startedAt {
            let s = Int(Date().timeIntervalSince(start))
            item.button?.title = String(format: "● %d:%02d", s / 60, s % 60)
            status = recorder.windowName.map { "Reading \($0) · \(recorder.linesWritten) table states" }
                ?? "Waiting for a \(recorder.target == .auto ? "poker" : recorder.target.rawValue) table window…"
        } else {
            item.button?.title = ready ? "♠" : "♠…"
        }

        let menu = NSMenu()
        let header = NSMenuItem(title: status, action: nil, keyEquivalent: ""); header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())
        if recorder.isRecording {
            menu.addItem(withTitle: "End session and get report", action: #selector(end), keyEquivalent: "e").target = self
        } else {
            let start = menu.addItem(withTitle: "Start session", action: #selector(start), keyEquivalent: "s")
            start.target = self; start.isEnabled = ready
            let sub = NSMenu()
            for t in Target.allCases {
                let mi = sub.addItem(withTitle: t.rawValue, action: #selector(pickTarget(_:)), keyEquivalent: "")
                mi.target = self; mi.representedObject = t.rawValue; mi.state = t == recorder.target ? .on : .off
            }
            let tItem = NSMenuItem(title: "Table: \(recorder.target.rawValue)", action: nil, keyEquivalent: "")
            tItem.submenu = sub
            menu.addItem(tItem)
        }
        if lastSession != nil {
            menu.addItem(withTitle: "Open last report", action: #selector(openReport), keyEquivalent: "").target = self
            menu.addItem(withTitle: "Show session folder", action: #selector(showFolder), keyEquivalent: "").target = self
        }
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit", action: #selector(quit), keyEquivalent: "q").target = self
        item.menu = menu
    }

    @objc func pickTarget(_ sender: NSMenuItem) {
        if let raw = sender.representedObject as? String, let t = Target(rawValue: raw) {
            recorder.target = t; UserDefaults.standard.set(raw, forKey: "target")
        }
        refresh()
    }

    @objc func start() {
        guard ready else { return }
        do { try recorder.start() } catch { status = "Could not start: \(error.localizedDescription)" }
        refresh()
    }

    @objc func end() {
        let started = recorder.startedAt ?? Date()
        guard let dir = recorder.stop() else { return }
        lastSession = dir
        // PokerNow: the game's own log is exact. Use one downloaded during this session.
        if let log = newestPokerNowLog(since: started) {
            try? FileManager.default.copyItem(at: log, to: dir.appendingPathComponent("pokernow_log.csv"))
            status = "Session saved · using PokerNow log \(log.lastPathComponent)"
        } else {
            status = "Session saved · \(recorder.linesWritten) table states"
        }
        refresh()
        openReport()
    }

    func newestPokerNowLog(since: Date) -> URL? {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let files = (try? FileManager.default.contentsOfDirectory(at: downloads, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        return files.filter { $0.lastPathComponent.hasPrefix("poker_now_log") && $0.pathExtension == "csv" }
            .compactMap { u -> (URL, Date)? in
                guard let d = try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate, d >= since else { return nil }
                return (u, d)
            }
            .max { $0.1 < $1.1 }?.0
    }

    @objc func openReport() {
        guard let dir = lastSession else { return }
        var c = URLComponents(string: reportBase)!
        c.queryItems = [URLQueryItem(name: "capture", value: dir.path)]
        if let url = c.url { NSWorkspace.shared.open(url) }
    }

    @objc func showFolder() { if let dir = lastSession { NSWorkspace.shared.activateFileViewerSelecting([dir]) } }
    @objc func quit() { _ = recorder.stop(); NSApp.terminate(nil) }
}

let args = CommandLine.arguments
if args.count >= 3, args[1] == "read" {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { print("cannot open image"); exit(1) }
    let t0 = Date()
    let r = TableReader.read(image)
    print("\(r.boxes.count) text boxes, \(r.cards.count) card regions in \(String(format: "%.2f", Date().timeIntervalSince(t0)))s")
    for b in r.boxes.prefix(40) { print(String(format: "  %-24@ (%.3f,%.3f) rgb%@", b.s, b.x, b.y, b.rgb.description)) }
    for c in r.cards { print(String(format: "  card (%.3f,%.3f %.3fx%.3f) ink%@ sig %@…", c.x, c.y, c.w, c.h, c.rgb.description, String(c.sig.prefix(24)))) }
} else {
    MainActor.assumeIsolated {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)   // menu bar only, no Dock icon
        app.run()
    }
}

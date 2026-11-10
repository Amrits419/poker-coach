import Foundation
import Vision
import CoreGraphics

/// Turns one table image into text: every piece of text Apple Vision reads (stacks, bets,
/// pot, names, action labels) and every card-shaped white region with a small numeric
/// fingerprint of its corner (rank + suit pip), so cards can be told apart later without
/// keeping any image.
enum TableReader {
    struct Box: Encodable { let s: String; let c: Float; let x, y, w, h: Double; let rgb: [Int] }
    struct Card: Encodable { let x, y, w, h: Double; let sig: String; let rgb: [Int] }

    static func read(_ image: CGImage) -> (boxes: [Box], cards: [Card]) { (text(image), cards(image)) }

    static func text(_ image: CGImage) -> [Box] {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = false
        req.minimumTextHeight = 0.008
        try? VNImageRequestHandler(cgImage: image, options: [:]).perform([req])
        return (req.results ?? []).compactMap { obs in
            guard let top = obs.topCandidates(1).first else { return nil }
            let b = obs.boundingBox   // normalised, origin bottom-left
            let rect = CGRect(x: b.minX, y: 1 - b.maxY, width: b.width, height: b.height)
            return Box(s: top.string, c: top.confidence, x: r4(rect.minX), y: r4(rect.minY), w: r4(rect.width), h: r4(rect.height),
                       rgb: inkColor(image, rect))
        }
    }

    /// Near-white regions with a card-like shape. Overlapping cards merge into one wider
    /// region; its top-left corner still shows the left card's rank and suit.
    static func cards(_ image: CGImage) -> [Card] {
        let n = 4, w = max(1, image.width / n), h = max(1, image.height / n)
        var px = [UInt8](repeating: 0, count: w * h * 4)
        px.withUnsafeMutableBytes { raw in
            CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?
                .draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        }
        var white = [Bool](repeating: false, count: w * h)
        for i in 0..<(w * h) { white[i] = px[i * 4] > 225 && px[i * 4 + 1] > 225 && px[i * 4 + 2] > 225 }
        var seen = [Bool](repeating: false, count: w * h)
        var out: [Card] = []
        for y in 0..<h { for x in 0..<w where white[y * w + x] && !seen[y * w + x] {
            var stack = [(x, y)]; seen[y * w + x] = true
            var minx = x, maxx = x, miny = y, maxy = y, count = 0
            while let (cx, cy) = stack.popLast() {
                count += 1; minx = min(minx, cx); maxx = max(maxx, cx); miny = min(miny, cy); maxy = max(maxy, cy)
                for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                    let nx = cx + dx, ny = cy + dy
                    if nx >= 0, ny >= 0, nx < w, ny < h, white[ny * w + nx], !seen[ny * w + nx] { seen[ny * w + nx] = true; stack.append((nx, ny)) }
                }
            }
            let bw = maxx - minx + 1, bh = maxy - miny + 1
            let tall = Double(bh) / Double(bw)
            // one card (taller than wide) or a fanned pair (up to ~2.2 cards wide)
            guard bw >= 5, bh >= 8, tall > 0.6, tall < 1.9, Double(count) > 0.45 * Double(bw * bh) else { continue }
            let rect = CGRect(x: minx * n, y: miny * n, width: bw * n, height: bh * n)
            let cardW = min(rect.width, rect.height / 1.4)   // width of one card
            let corner = CGRect(x: rect.minX, y: rect.minY, width: cardW * 0.5, height: rect.height * 0.45).integral
            guard let crop = image.cropping(to: corner) else { continue }
            let W = Double(image.width), H = Double(image.height)
            out.append(Card(x: r4(rect.minX / W), y: r4(rect.minY / H), w: r4(rect.width / W), h: r4(rect.height / H),
                            sig: signature(crop), rgb: inkColor(image, CGRect(x: corner.minX / W, y: corner.minY / H, width: corner.width / W, height: corner.height / H))))
        } }
        return out
    }

    /// 10×14 grayscale thumbnail, contrast-stretched, as hex (280 chars).
    static func signature(_ crop: CGImage) -> String {
        let w = 10, h = 14
        var g = [UInt8](repeating: 0, count: w * h)
        g.withUnsafeMutableBytes { raw in
            if let ctx = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                   space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) {
                ctx.interpolationQuality = .medium
                ctx.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
            }
        }
        let lo = Int(g.min() ?? 0), hi = Int(g.max() ?? 255), span = max(1, hi - lo)
        return g.map { String(format: "%02x", (Int($0) - lo) * 255 / span) }.joined()
    }

    private static func r4(_ v: CGFloat) -> Double { (Double(v) * 10000).rounded() / 10000 }
    private static func r4(_ v: Double) -> Double { (v * 10000).rounded() / 10000 }

    /// Average colour of the ink: whichever pixels are the minority side of the box's mean
    /// brightness (dark text on light cards, light text on dark felt).
    static func inkColor(_ image: CGImage, _ rect: CGRect) -> [Int] {
        let px = CGRect(x: rect.minX * CGFloat(image.width), y: rect.minY * CGFloat(image.height),
                        width: rect.width * CGFloat(image.width), height: rect.height * CGFloat(image.height)).integral
        guard px.width >= 2, px.height >= 2, let crop = image.cropping(to: px) else { return [0, 0, 0] }
        let n = 16
        var buf = [UInt8](repeating: 0, count: n * n * 4)
        buf.withUnsafeMutableBytes { raw in
            CGContext(data: raw.baseAddress, width: n, height: n, bitsPerComponent: 8, bytesPerRow: n * 4,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?
                .draw(crop, in: CGRect(x: 0, y: 0, width: n, height: n))
        }
        var lum: [Double] = []
        for i in stride(from: 0, to: buf.count, by: 4) { lum.append(0.299 * Double(buf[i]) + 0.587 * Double(buf[i + 1]) + 0.114 * Double(buf[i + 2])) }
        let mean = lum.reduce(0, +) / Double(lum.count)
        let inkIsDark = lum.filter { $0 < mean }.count <= lum.count / 2
        var sum = [0.0, 0.0, 0.0], count = 0.0
        for (k, l) in lum.enumerated() where inkIsDark ? l < mean - 10 : l > mean + 10 {
            sum[0] += Double(buf[k * 4]); sum[1] += Double(buf[k * 4 + 1]); sum[2] += Double(buf[k * 4 + 2]); count += 1
        }
        guard count > 0 else { return [Int(mean), Int(mean), Int(mean)] }
        return sum.map { Int($0 / count) }
    }

    /// The first Vision call loads its models (~45 s); do it before the session starts.
    static func warmUp() {
        let ctx = CGContext(data: nil, width: 64, height: 32, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
        ctx.setFillColor(gray: 1, alpha: 1); ctx.fill(CGRect(x: 0, y: 0, width: 64, height: 32))
        if let img = ctx.makeImage() { _ = text(img) }
    }
}

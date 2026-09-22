import AppKit
import Foundation

func iconPNG(size: Int) -> Data {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    let transform = NSAffineTransform()
    transform.scale(by: CGFloat(size) / 1024)
    transform.concat()

    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.18)
    shadow.shadowBlurRadius = 24
    shadow.shadowOffset = NSSize(width: 0, height: -12)
    shadow.set()
    NSColor(srgbRed: 49 / 255, green: 89 / 255, blue: 199 / 255, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 100, y: 100, width: 824, height: 824),
        xRadius: 184, yRadius: 184).fill()
    NSGraphicsContext.restoreGraphicsState()

    NSColor.white.setStroke()
    for diameter: CGFloat in [464, 208] {
        let ring = NSBezierPath(ovalIn: NSRect(x: (1024 - diameter) / 2,
            y: (1024 - diameter) / 2, width: diameter, height: diameter))
        ring.lineWidth = 48
        ring.stroke()
    }
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])!
}

let output = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .appendingPathComponent("build", isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
try iconPNG(size: 1024).write(to: output.appendingPathComponent("icon.png"))

let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
let iconset = temporary.appendingPathComponent("icon.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: temporary) }
for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let suffix = scale == 2 ? "@2x" : ""
        try iconPNG(size: points * scale).write(to: iconset
            .appendingPathComponent("icon_\(points)x\(points)\(suffix).png"))
    }
}
let conversion = Process()
conversion.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
conversion.arguments = ["--convert", "icns", "--output",
    output.appendingPathComponent("icon.icns").path, iconset.path]
try conversion.run()
conversion.waitUntilExit()
guard conversion.terminationStatus == 0 else { exit(conversion.terminationStatus) }
print("Generated build/icon.png and build/icon.icns")
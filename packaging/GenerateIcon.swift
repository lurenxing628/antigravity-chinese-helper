import AppKit
import Foundation

// 原创图标：青绿色圆角底板、白色对话气泡与琥珀色光点，不使用官方图形。
let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let variants = [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)]
for (size, scale) in variants {
    let pixels = size * scale
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                  isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.cgContext.scaleBy(x: CGFloat(pixels) / 1024, y: CGFloat(pixels) / 1024)

    let plate = NSBezierPath(roundedRect: NSRect(x: 52, y: 52, width: 920, height: 920), xRadius: 206, yRadius: 206)
    let gradient = NSGradient(starting: NSColor(srgbRed: 0.05, green: 0.25, blue: 0.32, alpha: 1),
                              ending: NSColor(srgbRed: 0.10, green: 0.57, blue: 0.56, alpha: 1))!
    gradient.draw(in: plate, angle: 65)
    NSColor.white.setFill()
    NSBezierPath(roundedRect: NSRect(x: 193, y: 262, width: 638, height: 508), xRadius: 112, yRadius: 112).fill()
    let tail = NSBezierPath()
    tail.move(to: NSPoint(x: 285, y: 305))
    tail.line(to: NSPoint(x: 285, y: 173))
    tail.line(to: NSPoint(x: 453, y: 305))
    tail.close()
    tail.fill()

    let text = "汉" as NSString
    let attributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 362, weight: .semibold),
        .foregroundColor: NSColor(srgbRed: 0.06, green: 0.36, blue: 0.41, alpha: 1),
    ]
    let textSize = text.size(withAttributes: attributes)
    text.draw(at: NSPoint(x: (1024 - textSize.width) / 2, y: 510 - textSize.height / 2), withAttributes: attributes)
    NSColor(srgbRed: 1, green: 0.71, blue: 0.27, alpha: 1).setFill()
    NSBezierPath(ovalIn: NSRect(x: 741, y: 735, width: 126, height: 126)).fill()

    NSGraphicsContext.restoreGraphicsState()
    let suffix = scale == 2 ? "@2x" : ""
    try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent("icon_\(size)x\(size)\(suffix).png"))
}

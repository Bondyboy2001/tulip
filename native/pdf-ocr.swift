import AppKit
import Foundation
import PDFKit
import Vision

struct OCRLine: Codable {
    let text: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct OCRPage: Codable {
    let page: Int
    let lines: [OCRLine]
}

struct OCROutput: Codable {
    let pages: [OCRPage]
    let errors: [String]
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}

guard CommandLine.arguments.count >= 3 else {
    fail("usage: pdf-ocr <document.pdf> <comma-separated one-based pages>", code: 2)
}

let source = URL(fileURLWithPath: CommandLine.arguments[1])
let requested = Set(CommandLine.arguments[2]
    .split(separator: ",")
    .compactMap { Int($0) }
    .filter { $0 > 0 })

guard !requested.isEmpty else { fail("no pages requested", code: 2) }
guard let document = PDFDocument(url: source) else { fail("the PDF could not be opened") }

var output: [OCRPage] = []
var errors: [String] = []

for number in requested.sorted() {
    guard number <= document.pageCount, let page = document.page(at: number - 1) else {
        errors.append("page \(number) is outside this document")
        continue
    }

    autoreleasepool {
        let bounds = page.bounds(for: .mediaBox)
        let longest = max(bounds.width, bounds.height)
        let scale = max(1.0, min(3.0, 2400.0 / max(1.0, longest)))
        let width = max(1, Int(ceil(bounds.width * scale)))
        let height = max(1, Int(ceil(bounds.height * scale)))
        guard let colour = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                data: nil,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: 0,
                space: colour,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              ) else {
            errors.append("page \(number) could not be rendered")
            return
        }

        context.setFillColor(NSColor.white.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.saveGState()
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: -bounds.minX, y: -bounds.minY)
        page.draw(with: .mediaBox, to: context)
        context.restoreGState()

        guard let image = context.makeImage() else {
            errors.append("page \(number) could not be rasterized")
            return
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        if #available(macOS 13.0, *) {
            request.automaticallyDetectsLanguage = true
        }

        do {
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
            let observations = request.results ?? []
            let lines = observations.compactMap { observation -> OCRLine? in
                guard let candidate = observation.topCandidates(1).first else { return nil }
                let box = observation.boundingBox
                return OCRLine(
                    text: candidate.string,
                    x: box.minX,
                    y: box.midY,
                    width: box.width,
                    height: box.height
                )
            }
            output.append(OCRPage(page: number, lines: lines))
        } catch {
            errors.append("page \(number): \(error.localizedDescription)")
        }
    }
}

do {
    let data = try JSONEncoder().encode(OCROutput(pages: output, errors: errors))
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    fail("OCR output could not be encoded: \(error.localizedDescription)")
}

import Foundation
import PDFKit
import Vision
import ImageIO
import Darwin

enum ProbeError: Error { case limit, invalid, noText }
struct PageEvidence: Codable { let page: Int; let method: String; let confidence: Float? }
struct Extraction: Codable { let text: String; let pages: [PageEvidence]; let version: Int }
let arguments = CommandLine.arguments
let ocr = arguments.contains("--ocr-json")
let pageLimit: Int = {
  guard let i = arguments.firstIndex(of: "--max-pages"), i + 1 < arguments.count,
        let n = Int(arguments[i + 1]), (1...100).contains(n) else { return 32 }
  return n
}()
func recognize(_ image: CGImage, orientation: CGImagePropertyOrientation = .up) throws -> (String, Float) {
  guard Int64(image.width) * Int64(image.height) <= 25_000_000 else { throw ProbeError.limit }
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.recognitionLanguages = ["de-DE", "en-US"]
  request.usesLanguageCorrection = true
  try VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:]).perform([request])
  let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first }
  return (lines.map(\.string).joined(separator: "\n"), lines.map(\.confidence).min() ?? 0)
}
func extraction() throws -> Extraction {
  var input = Data()
  while let chunk = try FileHandle.standardInput.read(upToCount: 65_536), !chunk.isEmpty {
    guard input.count + chunk.count <= 32 * 1024 * 1024 else { throw ProbeError.limit }
    input.append(chunk)
  }
  var output = "", evidence: [PageEvidence] = []
  func append(_ text: String, page: Int, method: String, confidence: Float? = nil) throws {
    guard output.utf8.count + text.utf8.count + 1 <= 2 * 1024 * 1024 else { throw ProbeError.limit }
    output += text + "\n"; evidence.append(PageEvidence(page: page, method: method, confidence: confidence))
  }
  if let document = PDFDocument(data: input) {
    guard !document.isEncrypted, !document.isLocked, document.pageCount > 0,
          document.pageCount <= (ocr ? pageLimit : 1000) else { throw ProbeError.limit }
    for index in 0..<document.pageCount {
      try autoreleasepool {
        guard let page = document.page(at: index) else { throw ProbeError.invalid }
        let embedded = page.string ?? ""
        if !ocr { try append(embedded, page: index + 1, method: "embedded"); return }
        let bounds = page.bounds(for: .mediaBox)
        guard bounds.width > 0, bounds.height > 0 else { throw ProbeError.invalid }
        let scale = min(2.0, 4096.0 / max(bounds.width, bounds.height))
        let width = max(1, Int(bounds.width * scale)), height = max(1, Int(bounds.height * scale))
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
          bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw ProbeError.limit }
        context.setFillColor(CGColor(gray: 1, alpha: 1));context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.scaleBy(x: scale, y: scale);context.translateBy(x: -bounds.minX, y: -bounds.minY)
        page.draw(with: .mediaBox, to: context)
        guard let image = context.makeImage() else { throw ProbeError.invalid }
        let (recognized, confidence) = try recognize(image)
        var seen = Set<String>()
        let combined = (embedded + "\n" + recognized).split(separator: "\n").map(String.init).filter { seen.insert($0.trimmingCharacters(in: .whitespaces)).inserted }.joined(separator: "\n")
        try append(combined, page: index + 1, method: embedded.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "ocr" : "embedded+ocr", confidence: confidence)
      }
    }
  } else {
    guard ocr, let source = CGImageSourceCreateWithData(input as CFData, nil) else { throw ProbeError.invalid }
    let count = CGImageSourceGetCount(source)
    guard count > 0, count <= pageLimit else { throw ProbeError.limit }
    for index in 0..<count {
      try autoreleasepool {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source,index,nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int,
          width > 0, height > 0, Int64(width) * Int64(height) <= 25_000_000,
          let image = CGImageSourceCreateImageAtIndex(source,index,nil) else { throw ProbeError.limit }
        let orientation = CGImagePropertyOrientation(rawValue: (properties[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1) ?? .up
        let (text, confidence) = try recognize(image, orientation: orientation)
        try append(text, page: index + 1, method: "ocr", confidence: confidence)
      }
    }
  }
  guard !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ProbeError.noText }
  return Extraction(text: output, pages: evidence, version: 1)
}
alarm(ocr ? 30 : 6)
do {
  let result = try extraction()
  try FileHandle.standardOutput.write(contentsOf: ocr ? JSONEncoder().encode(result) : Data(result.text.utf8))
} catch {
  try? FileHandle.standardError.write(contentsOf: Data("Document text unavailable: invalid/encrypted input, no recognized text, or extraction limit exceeded.\n".utf8))
  exit(2)
}

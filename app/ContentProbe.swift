import Foundation
import PDFKit
import Darwin

// Local, bounded PDF text extraction. No OCR, rendering, URLs or password guessing.
enum ContentProbeError: Error {
  case tooLarge, invalidPDF, noText
}

func extractPDFText() throws -> Data {
  let inputLimit = 32 * 1024 * 1024
  let textLimit = 2 * 1024 * 1024
  var input = Data()
  while let chunk = try FileHandle.standardInput.read(upToCount: 65_536), !chunk.isEmpty {
    guard input.count + chunk.count <= inputLimit else { throw ContentProbeError.tooLarge }
    input.append(chunk)
  }
  guard let document = PDFDocument(data: input), !document.isEncrypted, !document.isLocked,
        document.pageCount > 0, document.pageCount <= 1000 else { throw ContentProbeError.invalidPDF }
  var output = Data()
  for index in 0..<document.pageCount {
    guard let page = document.page(at: index), let text = page.string else { continue }
    let bytes = Data((text + "\n").utf8)
    guard output.count + bytes.count <= textLimit else { throw ContentProbeError.tooLarge }
    output.append(bytes)
  }
  guard let text = String(data: output, encoding: .utf8), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    throw ContentProbeError.noText
  }
  return output
}

// The parent has its own extraction deadline; also bound standalone helper use.
alarm(6)
do {
  let output = try extractPDFText()
  try FileHandle.standardOutput.write(contentsOf: output)
} catch {
  let message = "PDF text unavailable: invalid/encrypted/image-only PDF or extraction limit exceeded. OCR is not supported.\n"
  try? FileHandle.standardError.write(contentsOf: Data(message.utf8))
  exit(2)
}

import Foundation
import AVFoundation

// One bounded JSON request and response per line. This helper never opens a UI.
if CommandLine.arguments.contains("--version") {
  print("fe-media-probe 1")
  exit(0)
}
while let line = readLine() {
  autoreleasepool {
    var reply: [String: Any] = [:]
    do {
      guard line.utf8.count <= 16384,
            let data = line.data(using: .utf8),
            let request = try JSONSerialization.jsonObject(with: data) as? [String: String],
            let path = request["path"], path.hasPrefix("/"), !path.contains("\0") else {
        throw NSError(domain: "MediaProbe", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid local file request"])
      }
      let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
      let format = file.fileFormat
      guard format.sampleRate > 0, file.length > 0 else {
        throw NSError(domain: "MediaProbe", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unknown duration"])
      }
      let duration = Double(file.length) / format.sampleRate
      let code = format.streamDescription.pointee.mFormatID
      let bytes: [UInt8] = [UInt8((code >> 24) & 255), UInt8((code >> 16) & 255), UInt8((code >> 8) & 255), UInt8(code & 255)]
      let codec = String(bytes: bytes, encoding: .ascii)?.trimmingCharacters(in: .whitespaces) ?? "audio"
      reply = ["duration": duration, "codec": codec, "sampleRate": format.sampleRate, "channels": format.channelCount]
    } catch { reply = ["error": error.localizedDescription] }
    if let data = try? JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys]) {
      FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
  }
}

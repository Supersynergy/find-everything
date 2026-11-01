import Foundation

struct IndexingProgress: Decodable, Equatable {
  enum Phase: String, Decodable { case scan, prepare, complete }
  let phase: Phase
  let files: Int
  let bytesRead: Int?
  let totalBytes: Int?
  let paused: Bool

  init(phase: Phase = .scan, files: Int = 0, bytesRead: Int? = nil, totalBytes: Int? = nil, paused: Bool = false) {
    self.phase=phase;self.files=files;self.bytesRead=bytesRead;self.totalBytes=totalBytes;self.paused=paused
  }
  var fraction: Double? {
    if phase == .complete { return 1 }
    guard phase == .prepare, let done=bytesRead, let total=totalBytes, total>0 else { return nil }
    // Reading all paths is not completion: SQLite still has to finish its indexes.
    return min(0.99,max(0,Double(done)/Double(total)))
  }
  var percent: String? { fraction.map { "\(Int(($0*100).rounded(.down)))%" } }
  var activity: String {
    if paused { return "Indexing paused" }
    switch phase { case .scan: return "Discovering files"; case .prepare: return "Preparing search"; case .complete: return "Index ready" }
  }
  var accessibleValue: String { "\(activity), \(files.formatted()) files\(percent.map { ", \($0)" } ?? ", total not yet known")" }
  var valid: Bool { files>=0 && (bytesRead ?? 0)>=0 && (totalBytes ?? 0)>=0 }
}

/// Incremental NDJSON framing; no unbounded output buffer or trusted PID in progress messages.
struct IndexingProgressDecoder {
  private var pending=Data()
  mutating func append(_ data: Data) throws -> [IndexingProgress] {
    pending.append(data)
    var events:[IndexingProgress]=[]
    while let end=pending.firstIndex(of:10) {
      guard end<=65536 else { throw Self.invalid }
      let line=Data(pending[..<end]);pending.removeSubrange(...end)
      if line.isEmpty {continue}
      let event=try JSONDecoder().decode(IndexingProgress.self,from:line)
      guard event.valid else {throw Self.invalid};events.append(event)
    }
    guard pending.count<=65536 else {throw Self.invalid}
    return events
  }
  private static var invalid: NSError {NSError(domain:"FindEverythingIndex",code:1,userInfo:[NSLocalizedDescriptionKey:"Invalid or oversized index progress message"])}
}

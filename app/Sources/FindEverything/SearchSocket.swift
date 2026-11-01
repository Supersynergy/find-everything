import Foundation
import Darwin

struct SearchReply: Decodable {
  struct Coverage: Decodable { let matched: Int?;let metadataUnknown:Int? }
  struct FileProperty: Decodable {let path:String;let size:Double?;let mtime:Double?;let dir:Int?}
  let paths: [String]
  let warnings: [String]?
  let normalizedQuery: String?
  let coverage: Coverage?
  let nextOffset: Int?
  let snapshotId: String?
  let semantic: Bool?
  let provisional: Bool?
  let properties:[FileProperty]?
}

enum SearchSocket {
  private static let clientID=UUID().uuidString
  static let path = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".cache/hypersearch/run/search.sock").path

  static func search(_ query: String, index: String, offset: Int = 0, limit: Int = 300,generation:Int?=nil,interactive:Bool=false,preview:Bool=false) async throws -> SearchReply {
    var url = URLComponents(); url.path = "/v1/search"
    url.queryItems = [URLQueryItem(name:"q",value:query),URLQueryItem(name:"index",value:index),URLQueryItem(name:"limit",value:String(limit)),URLQueryItem(name:"offset",value:String(offset))]
    if let generation {url.queryItems! += [URLQueryItem(name:"client",value:clientID),URLQueryItem(name:"generation",value:String(generation)),URLQueryItem(name:"priority",value:interactive ? "foreground":"prefetch")]}
    if preview {url.queryItems!.append(URLQueryItem(name:"phase",value:"preview"))}
    return try await request(url.string!)
  }
  struct Updates: Decodable { let revision: String; let watching: Bool; let problem: String?; let pending: Int? }
  static func updates(index: String) async throws -> Updates {
    var url = URLComponents(); url.path = "/v1/updates"; url.queryItems = [URLQueryItem(name:"index",value:index)]
    return try await request(url.string!)
  }
  private static func request<T: Decodable>(_ route: String) async throws -> T {
    let cancellation=SocketCancellation()
    return try await withTaskCancellationHandler(operation:{
    try Task.checkCancellation()
    return try await Task.detached(priority: .userInitiated) {
      try cancellation.check()
      let fm = FileManager.default
      let attrs = try fm.attributesOfItem(atPath: path + ".json")
      guard (attrs[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
            ((attrs[.posixPermissions] as? NSNumber)?.intValue ?? 0o777) & 0o077 == 0,
            attrs[.type] as? FileAttributeType == .typeRegular else { throw failure("Unsafe search service credentials") }
      let info = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path + ".json"))) as? [String: Any]
      guard info?["apiRevision"] as? Int == 7 else { throw failure("Search service is outdated; restart it") }
      guard let token = info?["token"] as? String, token.count >= 32,
            token.allSatisfy({ $0.isHexDigit }) else { throw failure("Invalid search service credentials") }
      let fd = socket(AF_UNIX, SOCK_STREAM, 0)
      guard fd >= 0 else { throw failure("Cannot create search socket") }
      defer {cancellation.finish();close(fd)}
      try cancellation.install(fd)
      try cancellation.check()
      // Above the service's own 12 s search deadline, so its reply or error reaches
      // the UI first; a bare client timeout hides the real cause on cold starts.
      var timeout = timeval(tv_sec: 20, tv_usec: 0)
      setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
      setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
      var noSignal: Int32 = 1
      setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
      var addr = sockaddr_un()
      addr.sun_family = sa_family_t(AF_UNIX)
      addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
      let bytes = Array(path.utf8) + [0]
      guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { throw failure("Socket path too long") }
      withUnsafeMutableBytes(of: &addr.sun_path) { dst in dst.copyBytes(from: bytes) }
      let connected = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
      }
      guard connected == 0 else { throw failure("Search service is unavailable") }
      try cancellation.check()
      let request = Data("GET \(route) HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer \(token)\r\nConnection: close\r\n\r\n".utf8)
      try request.withUnsafeBytes { bytes in
        var sent = 0
        while sent < bytes.count {
          try cancellation.check()
          let count = Darwin.send(fd, bytes.baseAddress!.advanced(by: sent), bytes.count - sent, 0)
          guard count > 0 else { throw failure("Search service write failed") }; sent += count
        }
      }
      var response = Data(), buffer = [UInt8](repeating: 0, count: 16384)
      while true {
        try cancellation.check()
        let n = Darwin.recv(fd, &buffer, buffer.count, 0)
        let readError = errno
        try cancellation.check()
        if n < 0 {
          if readError == EINTR { continue }
          throw failure(readError == EAGAIN || readError == EWOULDBLOCK ? "Search service timed out" : "Search service read failed")
        }
        if n == 0 { break }
        response.append(contentsOf: buffer.prefix(n))
        guard response.count <= 4 * 1024 * 1024 else { throw failure("Search response exceeds limit") }
      }
      guard let split = response.range(of: Data("\r\n\r\n".utf8)) else { throw failure("Invalid search response") }
      let body = response.subdata(in: split.upperBound..<response.endIndex)
      let header = String(decoding: response[..<split.lowerBound], as: UTF8.self)
      guard header.hasPrefix("HTTP/1.1 200 ") else {
        let error = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        throw failure(error?["error"] as? String ?? "Search service failed")
      }
      return try JSONDecoder().decode(T.self, from: body)
    }.value
    },onCancel:{cancellation.cancel()})
  }

  private static func failure(_ message: String) -> NSError {
    NSError(domain: "FindEverythingSocket", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}

private final class SocketCancellation:@unchecked Sendable {
  private let lock=NSLock()
  private var fd:Int32 = -1
  private var canceled=false
  func check() throws {lock.lock();let value=canceled;lock.unlock();if value {throw CancellationError()}}
  func install(_ descriptor:Int32) throws {lock.lock();defer{lock.unlock()};if canceled {throw CancellationError()};fd=descriptor}
  func finish(){lock.lock();fd = -1;lock.unlock()}
  func cancel(){
    lock.lock();defer{lock.unlock()};canceled=true
    // shutdown wakes recv; only the reader closes the descriptor, avoiding reuse races.
    if fd>=0 {_ = Darwin.shutdown(fd,SHUT_RDWR)}
  }
}

import Foundation

struct WarmResults: Codable, Equatable {
  struct Entry: Codable, Equatable {let path:String;let size:Double?;let mtime:Double?;let directory:Bool?}
  let scope:String
  let query:String
  let total:Int
  let entries:[Entry]
  var valid:Bool {
    total>=entries.count && total<=100_000_000 && !entries.isEmpty && entries.count<=1000 &&
    entries.allSatisfy{$0.path.hasPrefix("/") && $0.path.utf8.count<=4096 && !$0.path.contains("\0") && !$0.path.contains("\n")}
  }
  static func load(_ url:URL,scope:String,query:String) -> Self? {
    guard let attrs=try? FileManager.default.attributesOfItem(atPath:url.path),
      let size=attrs[.size] as? NSNumber,size.intValue<=2*1024*1024,
      let data=try? Data(contentsOf:url),let view=try? JSONDecoder().decode(Self.self,from:data),
      view.valid,view.scope==scope,view.query==query else {return nil}
    return view
  }
  @discardableResult func save(_ url:URL) throws -> Bool {
    guard valid else {return false}
    let encoder=JSONEncoder();encoder.outputFormatting = .sortedKeys
    let data=try encoder.encode(self);guard data.count<=2*1024*1024 else {return false}
    if (try? Data(contentsOf:url))==data {return false}
    try FileManager.default.createDirectory(at:url.deletingLastPathComponent(),withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
    try data.write(to:url,options:.atomic)
    try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path)
    return true
  }
}

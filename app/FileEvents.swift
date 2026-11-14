import Foundation
import CoreServices
import Darwin

struct Target: Decodable { let name: String; let paths: [String]; let since: Double }
struct Root: Decodable { let path: String; let since: Double; let cursor: String?; let uuid: String?; let targets: [Target]?; let excludes: [String]? }
struct Config: Decodable { let roots: [Root] }
final class Watched {
  let root: String; let relative: String; let uuid: String; let device: dev_t
  let targets: [(String,[String],UInt64)]; let excludes: [String]
  // Replaying the journal after a rebuild covers millions of paths; a 5 s cap
  // dropped the replay on every reconcile and re-marked the scope as drifted.
  static let replayBudget: TimeInterval = 30
  var history = true; var seen = 0; let deadline = Date().addingTimeInterval(Watched.replayBudget)
  var stream: FSEventStreamRef?
  init(_ config: Root, _ relative: String, _ uuid: String, _ device: dev_t) {
    root=config.path; self.relative=relative; self.uuid=uuid; self.device=device
    excludes=config.excludes ?? []
    targets=(config.targets ?? []).map { ($0.name,$0.paths,FSEventsGetLastEventIdForDeviceBeforeTime(device,$0.since)) }
  }
}
var contexts: [Watched] = []
func emit(_ data: [String: Any]) {
  guard let bytes = try? JSONSerialization.data(withJSONObject: data) else { return }
  FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10]))
}
func under(_ path: String, _ root: String) -> Bool { path == root || path.hasPrefix(root == "/" ? "/" : root + "/") }
func tail(_ watched: Watched, _ reason: String) {
  guard watched.history else { return }; watched.history=false
  // A relative-to-device stream must resume with an ID from the same device.
  let checkpoint = FSEventsGetLastEventIdForDeviceBeforeTime(watched.device, Date().timeIntervalSince1970)
  var notice: [String:Any] = ["root":watched.root,"uuid":watched.uuid,"gap":reason]
  if checkpoint != 0 { notice["cursor"] = String(checkpoint) }
  emit(notice)
  if let old=watched.stream { FSEventStreamStop(old); FSEventStreamInvalidate(old); FSEventStreamRelease(old); watched.stream=nil }
  if !start(watched,checkpoint == 0 ? UInt64(kFSEventStreamEventIdSinceNow) : checkpoint) { emit(["root":watched.root,"gap":"Cannot start current event stream"]) }
}
let callback: FSEventStreamCallback = { _, context, count, raw, flags, ids in
  let w = Unmanaged<Watched>.fromOpaque(context!).takeUnretainedValue()
  if w.history && (w.seen + count > 100000 || Date() > w.deadline) { tail(w,"Journal replay budget exceeded; explicit reconciliation required"); return }
  w.seen += count
  let paths = unsafeBitCast(raw, to: NSArray.self) as! [String]
  var batch: [[String: Any]] = []
  for i in 0..<count {
    let p=paths[i].trimmingCharacters(in:CharacterSet(charactersIn:"/")), rel=w.relative.trimmingCharacters(in:CharacterSet(charactersIn:"/"))
    guard p == rel || p.hasPrefix(rel + "/") || rel.isEmpty else { emit(["root":w.root,"uuid":w.uuid,"cursor":String(ids[i]),"gap":"Unmapped event path"]); continue }
    let suffix=rel.isEmpty ? p : String(p.dropFirst(rel.count)).trimmingCharacters(in:CharacterSet(charactersIn:"/"))
    let absolute=suffix.isEmpty ? w.root : (w.root as NSString).appendingPathComponent(suffix)
    let historyDone = flags[i] & UInt32(kFSEventStreamEventFlagHistoryDone) != 0
    if historyDone { w.history=false }
    let parts=suffix.split(separator:"/").map(String.init)
    let excluded=parts.contains { part in w.excludes.contains { fnmatch($0,part,0) == 0 } }
    let targets=w.targets.filter { ids[i] > $0.2 && $0.1.contains { under(absolute,$0) } }.map { $0.0 }
    if historyDone || (!excluded && (w.targets.isEmpty || !targets.isEmpty)) {
      batch.append(["path":absolute,"flags":flags[i],"scopes":targets])
    }
    if batch.count == 128 || i == count-1 {
      emit(["root":w.root,"uuid":w.uuid,"cursor":String(ids[i]),"events":batch]);batch.removeAll(keepingCapacity:true)
    }
  }
}
func start(_ watched: Watched, _ since: UInt64) -> Bool {
  var context=FSEventStreamContext(version:0,info:Unmanaged.passUnretained(watched).toOpaque(),retain:nil,release:nil,copyDescription:nil)
  guard let stream=FSEventStreamCreateRelativeToDevice(nil,callback,&context,watched.device,[watched.relative] as CFArray,since,0.25,
    FSEventStreamCreateFlags(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagWatchRoot)) else { return false }
  FSEventStreamSetDispatchQueue(stream,DispatchQueue.main)
  guard FSEventStreamStart(stream) else { FSEventStreamInvalidate(stream);FSEventStreamRelease(stream);return false }
  watched.stream=stream;return true
}
do {
  let input=FileHandle.standardInput.readDataToEndOfFile();guard input.count<=131072 else { throw NSError(domain:"config",code:1) }
  let config=try JSONDecoder().decode(Config.self,from:input);guard !config.roots.isEmpty && config.roots.count<=64 else { throw NSError(domain:"roots",code:1) }
  for item in config.roots {
    var st=stat(), mount=statfs()
    guard stat(item.path,&st)==0, statfs(item.path,&mount)==0, let value=FSEventsCopyUUIDForDevice(st.st_dev) else { emit(["root":item.path,"gap":"Volume journal unavailable"]);continue }
    let uuid=CFUUIDCreateString(nil,value)! as String
    let mountPath=withUnsafePointer(to:&mount.f_mntonname) { $0.withMemoryRebound(to:CChar.self,capacity:Int(MAXPATHLEN)) { String(cString:$0) } }
    var physical=[CChar](repeating:0,count:Int(MAXPATHLEN));let fd=open(item.path,O_RDONLY)
    guard fd>=0 else { emit(["root":item.path,"gap":"Root cannot be opened"]);continue };defer { close(fd) }
    guard fcntl(fd,F_GETPATH_NOFIRMLINK,&physical)==0 else { emit(["root":item.path,"gap":"Physical volume path unavailable"]);continue }
    let full=String(cString:physical)
    guard full==mountPath || mountPath=="/" || full.hasPrefix(mountPath+"/") else { emit(["root":item.path,"gap":"Root is outside its volume mount"]);continue }
    let relative=full==mountPath ? "" : String(full.dropFirst(mountPath.count + (mountPath=="/" ? 0 : 1)))
    var since=FSEventsGetLastEventIdForDeviceBeforeTime(st.st_dev,item.since), gap:String?
    if let cursor=item.cursor,item.uuid==uuid,let id=UInt64(cursor) { since=id }
    else if item.uuid != nil { gap="Volume identity changed" }
    let w=Watched(item,relative,uuid,st.st_dev);contexts.append(w)
    if since==0 { since=UInt64(kFSEventStreamEventIdSinceNow);gap="Journal history unavailable; explicit reconciliation required";w.history=false }
    guard start(w,since) else { emit(["root":item.path,"gap":"Cannot start volume event stream"]);continue }
    var ready:[String:Any]=["root":item.path,"uuid":uuid,"ready":true]
    if let gap { ready["gap"]=gap };emit(ready)
    DispatchQueue.main.asyncAfter(deadline:.now()+Watched.replayBudget) { if w.history { tail(w,"Journal replay timeout; explicit reconciliation required") } }
  }
  guard contexts.contains(where:{$0.stream != nil}) else { exit(1) }
  dispatchMain()
} catch { FileHandle.standardError.write(Data("fe-events: \(error)\n".utf8));exit(1) }

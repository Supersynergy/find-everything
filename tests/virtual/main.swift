import Foundation

var cache = VirtualResults<String>()
cache.budget = 4000
let total = 11_826_147
precondition(cache.count == 0 && cache.bytes == 0)
let targets = VirtualResults<String>.requests(visible: (total - 40)..<total, total: total)
precondition(targets.first == 11_826_000 && targets.allSatisfy { $0 < total })
precondition(VirtualResults<String>.requests(visible: 0..<0, total: 0).isEmpty)
precondition(cache.insert(["first"], at: 0, cost: 1000))
precondition(!cache.insert(["first"], at: 0, cost: 1000))
for page in 1...3 { cache.insert(["row-\(page)"], at: page * 1000, cost: 1000) }
precondition(cache.value(at: 0) == "first")
cache.insert(["last"], at: 11_826_000, cost: 1000)
precondition(cache.value(at: 1000) == nil && cache.value(at: 0) == "first")
precondition(cache.value(at: 11_826_000) == "last" && cache.value(at: 11_826_001) == nil)
for page in 0..<100 { cache.insert(["\(page)"], at: page * 1000, cost: 1000) }
precondition(cache.bytes <= cache.budget && cache.pageCount == 4)
precondition(!cache.insert(["bad"], at: 12, cost: 1))
cache.budget=1000;precondition(cache.bytes<=1000 && cache.pageCount==1)
precondition(!cache.insert(["oversized"],at:0,cost:2000))
cache.removeAll(); precondition(cache.bytes == 0 && cache.count == 0)
cache.budget=2000
cache.insert(["visible"],at:0,cost:1000);cache.insert(["old"],at:1000,cost:1000)
cache.insert(["prefetch"],at:2000,cost:1000,protecting:[0])
precondition(cache.value(at:0)=="visible" && !cache.contains(1000))
precondition(!cache.insert(["too much"],at:3000,cost:2000,protecting:[0]))
precondition(cache.value(at:0)=="visible" && cache.bytes<=cache.budget)
print("Virtual results: full-index addressing, viewport priority, warm reuse and bounded LRU pass")
let dir=FileManager.default.temporaryDirectory.appendingPathComponent("fe-warm-\(UUID().uuidString)")
defer {try? FileManager.default.removeItem(at:dir)}
let file=dir.appendingPathComponent("startup.json")
let warm=WarmResults(scope:"demo",query:"omit:system",total:11_826_147,entries:[.init(path:"/tmp/überblick.wav",size:12,mtime:3,directory:false)])
let firstWrite=try warm.save(file);precondition(firstWrite);let attrs=try FileManager.default.attributesOfItem(atPath:file.path)
let secondWrite=try warm.save(file);precondition(!secondWrite)
let afterWrite=try FileManager.default.attributesOfItem(atPath:file.path)
precondition(afterWrite[.modificationDate] as? Date == attrs[.modificationDate] as? Date)
precondition(WarmResults.load(file,scope:"demo",query:"omit:system")==warm)
precondition(WarmResults.load(file,scope:"other",query:"omit:system")==nil)
precondition(WarmResults.load(file,scope:"demo",query:"view:all")==nil)
precondition(!WarmResults(scope:"demo",query:"",total:1,entries:[.init(path:"relative",size:nil,mtime:nil,directory:nil)]).valid)
print("Startup view: bounded validation, scope isolation, atomic persistence and no-op writes pass")

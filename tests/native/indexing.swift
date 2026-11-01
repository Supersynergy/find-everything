import AppKit
import Foundation
import SwiftUI

@main struct NativeIndexingTests {
  @MainActor static func main() async throws {
    let app=NSApplication.shared
    _=app.setActivationPolicy(.prohibited)
    var decoder=IndexingProgressDecoder()
    let firstChunk=try decoder.append(Data("{\"phase\":\"scan\",\"files\":12,".utf8))
    precondition(firstChunk.isEmpty)
    let scan=try decoder.append(Data("\"paused\":false}\n".utf8))[0]
    precondition(scan.fraction == nil && scan.percent == nil,"Scanning has no known total; never invent a percentage")
    let known=IndexingProgress(phase:.prepare,files:12480,bytesRead:42,totalBytes:100)
    precondition(known.fraction == 0.42 && known.percent == "42%")
    precondition(IndexingProgress(phase:.prepare,bytesRead:100,totalBytes:100).percent == "99%","100% requires finalized SQLite indexes")
    precondition(IndexingProgress(phase:.complete).percent == "100%")
    precondition(IndexingProgress(phase:.prepare,files:12480,bytesRead:42,totalBytes:100,paused:true).activity == "Indexing paused")
    do {var bad=IndexingProgressDecoder();_=try bad.append(Data(repeating:120,count:65537));fatalError("Oversized progress accepted")} catch {}
    do {var bad=IndexingProgressDecoder();_=try bad.append(Data("{\"phase\":\"scan\",\"files\":-1,\"paused\":false}\n".utf8));fatalError("Invalid count accepted")} catch {}
    print("Indexing footer: bounded incremental decoding, unknown/known totals, true completion and paused labels pass")

    let defaults=UserDefaults.standard
    let oldFlag=defaults.object(forKey:"initialAllIndex.v1"),oldScope=defaults.object(forKey:"scope")
    defer {
      if let oldFlag {defaults.set(oldFlag,forKey:"initialAllIndex.v1")} else {defaults.removeObject(forKey:"initialAllIndex.v1")}
      if let oldScope {defaults.set(oldScope,forKey:"scope")} else {defaults.removeObject(forKey:"scope")}
    }
    defaults.removeObject(forKey:"initialAllIndex.v1")
    let model=Model();model.autoUpdate=false;model.ensureSearchService={}
    var created=false,indexCalls=0,inventories=0
    model.testRunTool={args in
      if args == ["indexes","--json"] {
        inventories += 1
        return created ? "[{\"name\":\"all\",\"paths\":[\"/fixture-only\"],\"stale\":false,\"exists\":true}]" : "[]"
      }
      precondition(args == ["index","--index","all","--progress-json"],"First-run indexing must explicitly target All and use controlled progress")
      created=true;indexCalls += 1;return ""
    }
    model.ensureIndexIfNeeded()
    for _ in 0..<2000 {await Task.yield();if created && !model.indexing {break}}
    model.testCancelSearch()
    precondition(created && indexCalls==1 && !model.indexing && model.scope.rawValue=="all")
    precondition(defaults.bool(forKey:"initialAllIndex.v1"),"First-run work is not repeated at each launch")
    let before=inventories;model.ensureIndexIfNeeded()
    for _ in 0..<2000 {await Task.yield();if inventories>before {break}}
    model.testCancelSearch();precondition(indexCalls==1)
    defaults.removeObject(forKey:"initialAllIndex.v1")
    let existing=Model();existing.autoUpdate=false;existing.ensureSearchService={}
    var loaded=false
    existing.testRunTool={args in
      precondition(args == ["indexes","--json"],"An existing All index must not be rebuilt on first-run migration")
      loaded=true;return "[{\"name\":\"all\",\"paths\":[\"/fixture-only\"],\"stale\":false,\"exists\":true}]"
    }
    existing.ensureIndexIfNeeded()
    for _ in 0..<2000 {await Task.yield();if loaded && defaults.bool(forKey:"initialAllIndex.v1") {break}}
    existing.testCancelSearch();precondition(loaded && !existing.indexing)
    print("First run: All automatically scheduled once, prior All snapshot reused, preferences restored; no real scan")

    if let cli=ProcessInfo.processInfo.environment["FE_NATIVE_INDEX_CLI"],let bun=ProcessInfo.processInfo.environment["FE_NATIVE_INDEX_BUN"] {
      let temp=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString,isDirectory:true)
      try FileManager.default.createDirectory(at:temp,withIntermediateDirectories:true)
      defer {try? FileManager.default.removeItem(at:temp)}
      let counter=temp.appendingPathComponent("counter"),scanner=temp.appendingPathComponent("fd")
      let script="#!\(bun)\nimport fs from 'node:fs';for(let i=0;i<300;i++){fs.writeFileSync(process.env.FE_TEST_COUNTER,String(i));process.stdout.write(process.env.FE_TEST_ROOT+'/file-'+i+'.txt\\0');await new Promise(r=>setTimeout(r,20));}\n"
      try script.write(to:scanner,atomically:true,encoding:.utf8)
      try FileManager.default.setAttributes([.posixPermissions:0o700],ofItemAtPath:scanner.path)
      let actual=Model();actual.autoUpdate=false;actual.scope = .all;actual.ensureSearchService={}
      actual.testExecutable=cli
      var environment=ProcessInfo.processInfo.environment
      environment["FE_DATA_DIR"]=temp.appendingPathComponent("cache").path;environment["FE_CONFIG_DIR"]=temp.appendingPathComponent("config").path
      environment["FE_FD"]=scanner.path;environment["FE_TEST_COUNTER"]=counter.path;environment["FE_TEST_ROOT"]=temp.path
      actual.testProcessEnvironment=environment
      actual.rebuild()
      try await eventually("Native pause must wait for owned-worker telemetry") {actual.canPauseIndexing && (actual.indexProgress?.files ?? 0)>0}
      actual.toggleIndexingPause()
      try await eventually("Native pause control must receive a paused acknowledgement") {actual.indexProgress?.paused == true && !actual.indexPausePending}
      let stopped=try String(contentsOf:counter,encoding:.utf8)
      try await Task.sleep(nanoseconds:200_000_000)
      let stillStopped=try String(contentsOf:counter,encoding:.utf8)
      precondition(stillStopped==stopped,"Native pause must stop actual scan IO")
      actual.toggleIndexingPause()
      try await eventually("Native resume must acknowledge and restart the same scanner") {actual.indexProgress?.paused == false && !actual.indexPausePending}
      try await eventually("Resumed scanner must produce files") {(try? String(contentsOf:counter,encoding:.utf8)) != stopped}
      actual.stopIndexing()
      try await eventually("Native cancel must clear indexing state and owned worker") {!actual.indexing && actual.indexProgress == nil}
      actual.testCancelSearch()
      precondition(actual.errorMessage == nil,"User cancellation must not become a search error")
      print("Native owned CLI: telemetry handshake, real pause/resume acknowledgement, stopped IO and cancellation pass")
    }

    if let marker=CommandLine.arguments.firstIndex(of:"--render"),marker+1<CommandLine.arguments.count {
      let output=URL(fileURLWithPath:CommandLine.arguments[marker+1],isDirectory:true)
      try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
      try render(scan,name:"indexing-scan",width:1040,appearance:.aqua,output:output)
      try render(known,name:"indexing-progress",width:1040,appearance:.aqua,output:output)
      let paused=IndexingProgress(phase:.prepare,files:12480,bytesRead:42,totalBytes:100,paused:true)
      try render(paused,name:"indexing-paused",width:1040,appearance:.darkAqua,output:output)
      try render(known,name:"indexing-narrow",width:640,appearance:.aqua,output:output)
    }
  }

  @MainActor static func eventually(_ message:String,condition:()->Bool) async throws {
    let deadline=Date(timeIntervalSinceNow:8)
    while !condition() && Date()<deadline {try await Task.sleep(nanoseconds:10_000_000)}
    precondition(condition(),message)
  }

  @MainActor static func render(_ progress:IndexingProgress,name:String,width:CGFloat,appearance:NSAppearance.Name,output:URL) throws {
    let model=Model();model.autoUpdate=false;model.display=DisplayPreferences();model.display.habitRanking=false
    model.display.appearance=appearance == .darkAqua ? "dark" : "light"
    model.scope=FEScope(rawValue:"all")!;model.indexing=true;model.indexingTarget="All (/)";model.indexProgress=progress
    model.ensureSearchService={fatalError("Rendering must not start a service")}
    model.testRunTool={_ in fatalError("Rendering must not run an index command")}
    let host=NSHostingView(rootView:RootView().environmentObject(model))
    let frame=NSRect(x:0,y:0,width:width,height:620)
    let window=NSWindow(contentRect:frame,styleMask:[.titled],backing:.buffered,defer:false)
    window.appearance=NSAppearance(named:appearance);host.frame=frame;window.contentView=host
    host.layoutSubtreeIfNeeded();RunLoop.current.run(until:Date(timeIntervalSinceNow:0.2));host.layoutSubtreeIfNeeded();host.displayIfNeeded()
    precondition(!window.isVisible && !NSApp.isActive,"No screen capture or focus stealing")
    guard let bitmap=host.bitmapImageRepForCachingDisplay(in:host.bounds) else {fatalError("No native bitmap")}
    host.cacheDisplay(in:host.bounds,to:bitmap)
    guard let png=bitmap.representation(using:.png,properties:[:]),png.count>4000 else {fatalError("Empty footer rendering")}
    try png.write(to:output.appendingPathComponent(name+".png"),options:.atomic)
    print("Rendered \(name): \(bitmap.pixelsWide)×\(bitmap.pixelsHigh), synthetic progress; controls disabled without a real worker")
    window.contentView=nil
  }
}

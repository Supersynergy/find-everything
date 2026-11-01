// Model-level regressions run in an invisible process with no external input.
import AppKit
import Foundation
import SwiftUI

@main struct NativeModelTests {
  @MainActor static func main() async throws {
    let app=NSApplication.shared
    _ = app.setActivationPolicy(.prohibited)
    func reply(_ paths:[String],snapshot:String?,total:Int) throws -> SearchReply {
      var json:[String:Any]=["paths":paths,"coverage":["matched":total]]
      if let snapshot {json["snapshotId"]=snapshot}
      return try JSONDecoder().decode(SearchReply.self,from:JSONSerialization.data(withJSONObject:json))
    }

    // The installed app kept Home selected even though only other saved scopes existed.
    // Inject only the bounded CLI response; exercise the real index-loading path.
    let previousScope=UserDefaults.standard.object(forKey:"scope")
    defer {if let previousScope {UserDefaults.standard.set(previousScope,forKey:"scope")} else {UserDefaults.standard.removeObject(forKey:"scope")}}
    let startup=Model()
    startup.scope = .home
    var inventory="""
      [{"name":"home","paths":["/fixture/home"],"stale":false,"exists":false},
       {"name":"downloads","paths":["/fixture/downloads"],"stale":false,"exists":true},
       {"name":"everything","paths":["/fixture"],"stale":false,"exists":true}]
      """
    startup.testRunTool={args in
      precondition(args == ["indexes","--json"],"Loading saved scopes must never scan folders")
      return inventory
    }
    await startup.loadIndexes()
    precondition(startup.scope.rawValue=="everything","Startup must use the existing combined index instead of unindexed Home")
    precondition(UserDefaults.standard.string(forKey:"scope")=="everything","The recovered startup scope must survive relaunch")
    startup.scope = .downloads
    await startup.loadIndexes()
    precondition(startup.scope == .downloads,"Keep the user's existing saved index")
    startup.scope=FEScope(rawValue:"removed")!
    await startup.loadIndexes()
    precondition(startup.scope.rawValue=="everything","A removed scope must fall back to an existing snapshot")
    inventory="""
    [{"name":"home","paths":["/fixture/home"],"stale":false,"exists":false},
     {"name":"downloads","paths":["/fixture/downloads"],"stale":false,"exists":true},
     {"name":"everything","paths":["/fixture"],"stale":false,"exists":false}]
    """
    startup.scope = .home
    await startup.loadIndexes()
    precondition(startup.scope == .downloads,"A configured but missing combined index must not be selected")
    var serviceStarts=0
    startup.ensureSearchService={serviceStarts += 1}
    startup.testSeed(paths:["/old-result"],query:"missing-index",snapshot:"old",selection:IndexSet(integer:0),lead:0,total:1)
    startup.scope = .home
    startup.onQueryChange(startup.query,force:true)
    precondition(startup.needsIndex && startup.scope == .home && !startup.searching && serviceStarts==0,"An explicit missing scope must not silently switch, scan or start a search")
    precondition(startup.errorMessage?.contains("Home has no saved index") == true && startup.resultCount==0 && startup.currentItem==nil,"Missing scopes need an actionable empty state, not stale results")
    let directPath=FileManager.default.temporaryDirectory.appendingPathComponent("fe-index-path-\(UUID().uuidString)")
    try Data().write(to:directPath)
    defer {try? FileManager.default.removeItem(at:directPath)}
    startup.query=directPath.path;startup.onQueryChange(startup.query,force:true)
    precondition(startup.currentItem?.path==directPath.path && startup.errorMessage==nil && serviceStarts==0,"Direct paths must remain usable without an index")
    inventory="[]"
    startup.scope = .home
    await startup.loadIndexes()
    precondition(startup.scope == .home && startup.needsIndex,"An empty inventory must not invent a saved index")
    inventory="[{\"name\":\"project\",\"paths\":[\"/fixture/project\"],\"stale\":true,\"exists\":true}]"
    await startup.loadIndexes()
    precondition(startup.scope.rawValue=="project" && !startup.needsIndex,"An older existing custom snapshot remains searchable")
    var rebuilt=false
    startup.scope = .home
    startup.testRunTool={args in
      if args == ["index","--index","home","--progress-json"] {rebuilt=true;return ""}
      precondition(args == ["indexes","--json"] && rebuilt)
      return "[{\"name\":\"home\",\"paths\":[\"/fixture/home\"],\"stale\":false,\"exists\":true}]"
    }
    startup.rebuild()
    for _ in 0..<1000 where startup.indexing {await Task.yield()}
    startup.testCancelSearch()
    precondition(rebuilt && !startup.indexing && !startup.needsIndex && startup.scope == .home,"Explicit indexing must reload availability before searching again")
    print("Index startup: existing fallback, persistence, explicit missing scopes, direct paths and rebuild recovery pass")

    let changed=Model()
    changed.testSeed(paths:["/a.mp3","/b.mp3"],query:"music",snapshot:"old",selection:IndexSet([0,1]),lead:1,total:1001)
    let changedPage=try reply(["/wrong.mp3"],snapshot:"new",total:1001)
    precondition(!changed.testAcceptPage(changedPage,offset:1000))
    precondition(changed.testSnapshot=="old" && changed.selectedRows==IndexSet([0,1]))
    precondition(changed.cachedResult(at:0)?.path=="/a.mp3" && changed.cachedResult(at:1)?.path=="/b.mp3")
    precondition(changed.testRefreshDeferred,"A changed snapshot must never rebind selected indexes")

    let background=Model()
    background.testSeed(paths:["/a.mp3","/b.mp3"],query:"music",snapshot:"old",selection:IndexSet([0,1]),lead:1,total:2)
    background.onQueryChange(background.query,preserveSelection:true,force:true)
    precondition(background.testRefreshDeferred && background.selectedRows==IndexSet([0,1]))
    precondition(background.cachedResult(at:0)?.path=="/a.mp3" && background.cachedResult(at:1)?.path=="/b.mp3")
    background.selectRows(IndexSet(integer:0),lead:0)
    precondition(!background.testRefreshDeferred,"Refreshing resumes when multi-selection ends")
    background.testCancelSearch()
    let explicitRefresh=Model()
    explicitRefresh.testSeed(paths:["/a.mp3","/b.mp3"],query:"music",snapshot:"old",selection:IndexSet([0,1]),lead:1,total:2)
    explicitRefresh.onQueryChange(explicitRefresh.query,preserveSelection:true,force:true)
    explicitRefresh.refreshDeferredResults()
    precondition(!explicitRefresh.selectionRefreshPaused && explicitRefresh.selectionNeedsConfirmation && explicitRefresh.selectedRows.isEmpty)
    explicitRefresh.testCancelSearch()

    let duringRefresh=Model()
    duringRefresh.testSeed(paths:["/a.mp3","/b.mp3","/c.mp3"],query:"music",snapshot:"old",selection:IndexSet([0,1]),lead:1,total:3)
    let refreshed=try reply(["/c.mp3","/b.mp3","/a.mp3"],snapshot:"new",total:3)
    precondition(duringRefresh.testPublishRefresh(refreshed,initialSelection:IndexSet(integer:0),initialLead:0))
    precondition(duringRefresh.selectedRows==IndexSet([1,2]) && duringRefresh.cachedResult(at:1)?.path=="/b.mp3" && duringRefresh.cachedResult(at:2)?.path=="/a.mp3")
    let missingDuringRefresh=Model()
    missingDuringRefresh.testSeed(paths:["/a.mp3","/b.mp3"],query:"music",snapshot:"old",selection:IndexSet([0,1]),lead:1,total:2)
    let changedResults=try reply(["/other.mp3","/b.mp3"],snapshot:"new",total:2)
    precondition(!missingDuringRefresh.testPublishRefresh(changedResults,initialSelection:IndexSet(integer:0),initialLead:0))
    precondition(missingDuringRefresh.testRefreshDeferred && missingDuringRefresh.testSnapshot=="old" && missingDuringRefresh.selectedRows==IndexSet([0,1]))
    let movedSingle=Model()
    movedSingle.testSeed(paths:["/a.mp3","/b.mp3","/c.mp3"],query:"music",snapshot:"old",selection:IndexSet(integer:1),lead:1,total:3)
    let reorderedSingle=try reply(["/b.mp3","/c.mp3","/a.mp3"],snapshot:"new",total:3)
    precondition(movedSingle.testPublishRefresh(reorderedSingle,initialSelection:IndexSet(integer:0),initialLead:0))
    precondition(movedSingle.currentItem?.path=="/b.mp3" && movedSingle.selected==0)

    let preview=Model()
    preview.testSeed(paths:["/a.mp3","/b.mp3","/c.mp3"],query:"music",snapshot:"old",selection:IndexSet([0,1]),lead:1,total:3,provisional:true)
    let exact=try reply(["/c.mp3","/b.mp3","/a.mp3"],snapshot:"new",total:3)
    precondition(preview.testPublishExactPreview(exact))
    precondition(preview.selectedRows==IndexSet([1,2]) && preview.selected==1)
    precondition(preview.cachedResult(at:1)?.path=="/b.mp3" && preview.cachedResult(at:2)?.path=="/a.mp3")
    let partial=Model()
    partial.testSeed(paths:["/a.mp3","/b.mp3"],query:"music",snapshot:"old",selection:IndexSet([0,1]),lead:1,total:2,provisional:true)
    let missing=try reply(["/b.mp3","/different.mp3"],snapshot:"new",total:2)
    precondition(!partial.testPublishExactPreview(missing))
    precondition(partial.testRefreshDeferred && partial.resultIsProvisional && partial.testSnapshot=="old")
    precondition(partial.cachedResult(at:0)?.path=="/a.mp3" && partial.selectedRows==IndexSet([0,1]))
    let missingSingle=Model()
    missingSingle.testSeed(paths:["/a.mp3"],query:"music",snapshot:"old",selection:IndexSet(integer:0),lead:0,total:1,provisional:true)
    let noLongerPresent=try reply(["/different.mp3"],snapshot:"new",total:1)
    precondition(missingSingle.testPublishExactPreview(noLongerPresent))
    precondition(missingSingle.selectionNeedsConfirmation && missingSingle.selectedRows.isEmpty && missingSingle.currentItem==nil)
    missingSingle.performSelected(.open)
    precondition(missingSingle.actionError != nil && !missingSingle.testPendingQuickAction,"Missing selected files must not be opened or queued")

    let paging=Model()
    paging.testSeed(paths:["/a.mp3"],query:"music",snapshot:"same",selection:IndexSet([0,1000]),lead:1000,total:1001)
    var previewChanges=0
    paging.selectionDidChange={previewChanges += 1}
    let page=try reply(["/b.mp3"],snapshot:"same",total:1001)
    precondition(paging.testAcceptPage(page,offset:1000))
    precondition(previewChanges==0 && paging.selectedRows==IndexSet([0,1000]))

    let delegate=AppDelegate(),model=delegate.model
    model.testSeed(paths:[],query:"nothing found",snapshot:"empty",selection:IndexSet(),lead:0,total:0)
    var openedWeb:String?
    model.testWebAction={openedWeb=$0}
    let enter=NSEvent.keyEvent(with:.keyDown,location:.zero,modifierFlags:[],timestamp:0,windowNumber:0,context:nil,characters:"\r",charactersIgnoringModifiers:"\r",isARepeat:false,keyCode:36)!
    precondition(delegate.handleKey(enter) && openedWeb=="nothing found","Enter on a settled empty search must use the web fallback")
    openedWeb=nil;model.searching=true
    precondition(delegate.handleKey(enter) && openedWeb==nil,"Pending searches must not open the web")
    model.searching=false;model.errorMessage="Search unavailable"
    precondition(delegate.handleKey(enter) && openedWeb==nil,"A failed search must not trigger the web fallback")
    model.errorMessage=nil
    model.testSeed(paths:["/a.mp3","/b.mp3"],query:"music",snapshot:"focus",selection:IndexSet([0,1]),lead:1,total:2)
    var selectedSearch=false
    model.inputFocus = .results;model.focusSearchField={selectedSearch=$0}
    delegate.preparePanelFocus();delegate.focusPanelSearch()
    precondition(selectedSearch && model.inputFocus == .search && model.selectedRows==IndexSet([0,1]),"Reopening must select the search text, not all result rows")
    selectedSearch=false;model.inputFocus = .results;delegate.focusPanelSearch()
    precondition(!selectedSearch,"A later user focus change must not be overwritten")

    // ⌘⌫ edits the line while the caret is in the search field; in the
    // results it still moves the selected file to the Trash.
    model.testSeed(paths:["/a.mp3","/b.mp3"],query:"music",snapshot:"clear",selection:IndexSet(integer:0),lead:0,total:2)
    model.inputFocus = .search
    var trashed:[String]=[]
    model.testTrashAction={trashed.append($0)}
    func key(_ code:UInt16,_ flags:NSEvent.ModifierFlags,_ chars:String) -> NSEvent {
      NSEvent.keyEvent(with:.keyDown,location:.zero,modifierFlags:flags,timestamp:0,windowNumber:0,context:nil,characters:chars,charactersIgnoringModifiers:chars,isARepeat:false,keyCode:code)!
    }
    let cmdBackspace=key(51,[.command],"\u{7f}")
    precondition(delegate.handleKey(cmdBackspace),"⌘⌫ must be handled while typing")
    precondition(model.query.isEmpty && trashed.isEmpty,"⌘⌫ while typing must clear the line, not trash the selection")
    precondition(model.inputFocus == .search,"Clearing must keep the caret in the search field")
    precondition(delegate.handleKey(key(6,[.command],"z")) && model.query=="music","⌘Z must bring a cleared query back")
    model.testCancelSearch()
    model.inputFocus = .results
    precondition(delegate.handleKey(cmdBackspace) && trashed==["/a.mp3"],"⌘⌫ in the results must still move the file to the Trash")
    model.testCancelSearch()
    model.testSeed(paths:["/a.mp3","/b.mp3","/c.mp3"],query:"music",snapshot:"home",selection:IndexSet(integer:1),lead:1,total:3)
    model.inputFocus = .search
    precondition(!delegate.handleKey(key(115,[],"")),"Home must stay text navigation while the caret is in the search field")
    model.inputFocus = .results
    precondition(delegate.handleKey(key(115,[],"")) && model.selected==0,"Home in the results must jump to the first row")

    let filter=Model()
    filter.testSeed(paths:["/a.wav","/b.flac"],query:"ext:mp3",snapshot:"filter",selection:IndexSet([0,1]),lead:1,total:2)
    let host=NSHostingView(rootView:ColumnFilterRow(column:.type).environmentObject(filter))
    let window=NSWindow(contentRect:NSRect(x:0,y:0,width:700,height:160),styleMask:[.titled],backing:.buffered,defer:false)
    window.contentView=host;host.layoutSubtreeIfNeeded()
    settleUI()
    guard let field=descendants(host).compactMap({$0 as? NSTextField}).first(where:{$0.isEditable}) else {fatalError("Filter text field not found")}
    precondition(field.stringValue=="mp3")
    filter.filterSelectionTypes()
    for _ in 0..<1000 where SearchQueryOptions.value("ext",in:filter.query) != "flac;wav" {await Task.yield()}
    precondition(SearchQueryOptions.value("ext",in:filter.query)=="flac;wav")
    filter.testCancelSearch()
    settleUI()
    precondition(field.stringValue=="flac;wav","An open type-filter field must follow an external filter change")
    guard let presets=descendants(host).compactMap({$0 as? NSScrollView}).first else {fatalError("Preset list not found")}
    let actions=descendants(host).compactMap{$0 as? NSButton}.filter{!$0.isDescendant(of:presets)}
    precondition(actions.count==2 && actions[0].isEnabled,"Expected Apply and Clear controls")
    actions[0].performClick(nil)
    precondition(SearchQueryOptions.value("ext",in:filter.query)=="flac;wav","Apply must not restore the old filter")
    filter.testCancelSearch()
    print("Native model: snapshot safety, preserved selections, preview paging, focus, web fallback and filter synchronization pass")
  }
  @MainActor static func settleUI() {RunLoop.current.run(until:Date(timeIntervalSinceNow:0.15))}
  @MainActor static func descendants(_ view:NSView)->[NSView] {
    [view]+view.subviews.flatMap{descendants($0)}
  }
}

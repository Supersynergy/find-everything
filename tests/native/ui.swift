// Off-screen AppKit integration test for the production virtual results table.
// It creates no visible windows and never sends input to another process.
import AppKit
import SwiftUI
import Foundation

struct FEItem {let path:String;var url:URL {URL(fileURLWithPath:path)}}
struct DisplayPreferences:Equatable {var compact=true;var fontSize:Double=13}
@MainActor final class Model:ObservableObject {
  @Published var selectedRows=IndexSet(integer:0)
  @Published var selected=0
  @Published var resultCount=3
  let resultIdentity=1,virtualRevision=1
  @Published var keyboardSelection=0
  let display=DisplayPreferences()
  let pinnedPaths:[String]=[]
  let pinnedSet:Set<String>=[]
  let hasResultGroups=false,resultFocused=false,showOptions=false,editingColumnFilter=false,showActions=false,showHelp=false
  var focusResultsField:(()->Void)?
  var canInteractWithResults=true
  var focusCount=0
  func focusResults() {focusCount += 1}
  func beginMouseSelection(_ row:Int) -> Bool {
    guard canInteractWithResults else {return false}
    focusResults();return true
  }
  var lastAction=""
  private let fixtures=[FEItem(path:"/tmp/fe-test-a.mp3"),FEItem(path:"/tmp/fe-test-b.mp3"),FEItem(path:"/tmp/fe-test-c.mp3")]
  func cachedResult(at row:Int)->FEItem? {fixtures.indices.contains(row) ? fixtures[row] : nil}
  func requestResults(_ range:Range<Int>) {}
  func selectRows(_ rows:IndexSet,lead:Int) {selectedRows=rows;selected=lead}
  func openSelection(with application:URL?=nil) {lastAction="open"}
  func chooseApplicationForSelection() {lastAction="choose"}
  func performSelected(_ action:SelectedQuickAction) {lastAction="preview"}
  func openSelectionFolder() {lastAction="folder"}
  func revealSelection() {lastAction="reveal"}
  func copySelectionPaths() {lastAction="paths"}
  func filterSelectionTypes() {lastAction="types"}
  func searchInFolder(_ path:String) {}
  func openTerminal(_ path:String) {}
  func copyName(_ path:String) {}
  func copyFile(_ path:String) {}
  func copyContents(_ path:String) {}
  func togglePin(_ path:String) {}
  func duplicate(_ path:String) {}
  func compress(_ path:String) {}
  func getInfo(_ path:String) {}
  func trash(_ path:String) {}
}

@main struct NativeTableTest {
  @MainActor static func main() {
    let app=NSApplication.shared
    _ = app.setActivationPolicy(.prohibited)
    let model=Model()
    let root=VirtualResultTable {item,_ in AnyView(Text(item.path))}.environmentObject(model)
    let host=NSHostingView(rootView:root)
    let window=NSWindow(contentRect:NSRect(x:0,y:0,width:600,height:300),styleMask:[.titled],backing:.buffered,defer:false)
    window.contentView=host
    precondition(!window.isVisible && !app.isActive,"The test window must not take keyboard focus")
    host.layoutSubtreeIfNeeded()
    RunLoop.current.run(until:Date(timeIntervalSinceNow:0.25))
    guard let table=findTable(host) else {fatalError("Virtual results table was not created")}
    table.layoutSubtreeIfNeeded()
    precondition(table.numberOfRows==3 && table.allowsMultipleSelection)
    guard let cell=table.view(atColumn:0,row:1,makeIfNecessary:true) else {fatalError("Missing result cell")}
    precondition(cell.hitTest(.zero)==nil,"Result cells must pass pointer events to the table")
    let rowPoint=NSPoint(x:20,y:table.rect(ofRow:1).midY)
    guard let hit=table.hitTest(table.convert(rowPoint,to:table.superview)) else {fatalError("Table does not receive row hit tests")}
    precondition(hit === table || hit.isDescendant(of:table),"A result hit must remain in the table")
    let down=mouseEvent(.leftMouseDown,table:table,window:window,row:0,flags:[])
    app.postEvent(mouseEvent(.leftMouseUp,table:table,window:window,row:0,flags:[]),atStart:false)
    table.mouseDown(with:down)
    precondition(model.focusCount==1,"Clicking an already selected row must focus the results")
    table.selectRowIndexes(IndexSet(integer:1),byExtendingSelection:false)
    precondition(model.selectedRows==IndexSet(integer:1),"Table selection must reach the model")
    table.selectRowIndexes(IndexSet(integer:2),byExtendingSelection:true)
    precondition(model.selectedRows==IndexSet([1,2]),"Extended selection must keep both rows")
    let right=mouseEvent(.rightMouseDown,table:table,window:window,row:2,flags:[])
    guard let menu=table.menu(for:right) else {fatalError("Missing result context menu")}
    let titles=menu.items.map(\.title)
    for title in ["Open 2 Selected Files","Open With","Quick Look","Open Containing Folder","Show in Finder","Copy Paths","Filter by Selected File Types"] {
      precondition(titles.contains(title),"Missing context action \(title)")
    }
    guard let copy=menu.items.first(where:{$0.title=="Copy Paths"}),let action=copy.action else {fatalError("Copy paths action missing")}
    precondition(app.sendAction(action,to:copy.target,from:copy) && model.lastAction=="paths")
    let other=mouseEvent(.rightMouseDown,table:table,window:window,row:0,flags:[])
    precondition(table.menu(for:other) != nil && model.selectedRows==IndexSet(integer:0),"Right-clicking an unselected row selects it")
    guard let doubleAction=table.doubleAction else {fatalError("Double-click action missing")}
    precondition(app.sendAction(doubleAction,to:table.target,from:table) && model.lastAction=="open")
    model.lastAction="";model.canInteractWithResults=false
    precondition(table.menu(for:other)==nil)
    table.mouseDown(with:down)
    precondition(model.focusCount==1,"Stale results must not accept clicks")
    precondition(app.sendAction(doubleAction,to:table.target,from:table) && model.lastAction.isEmpty,"Stale results must not open")
    model.canInteractWithResults=true;model.resultCount=68_903_790
    model.selected=68_903_789;model.selectedRows=IndexSet(integer:model.selected);model.keyboardSelection += 1
    RunLoop.current.run(until:Date(timeIntervalSinceNow:0.25));host.layoutSubtreeIfNeeded()
    precondition(table.numberOfRows==10_000,"AppKit row bookkeeping must remain bounded")
    precondition(table.selectedRow==9_999,"The last global result remains reachable")
    table.selectRowIndexes(IndexSet(integer:9_998),byExtendingSelection:false)
    precondition(model.selected==68_903_788,"Pointer selection must map back to global rows")
    var rowWindow=ResultRowWindow();rowWindow.include(68_903_789,total:68_903_790)
    precondition(rowWindow.global(rowWindow.local(68_903_789))==68_903_789 && rowWindow.count==10_000)
    rowWindow.include(0,total:68_903_790);precondition(rowWindow.offset==0)
    print("Native table: bounded 69M-row window and global last-result navigation pass")
    print("Native table: hit testing, focus hook, extended selection, context actions and stale-result guard pass")
  }
  @MainActor static func findTable(_ view:NSView)->NSTableView? {
    if let table=view as? NSTableView {return table}
    for child in view.subviews {if let table=findTable(child) {return table}}
    return nil
  }
  @MainActor static func mouseEvent(_ type:NSEvent.EventType,table:NSTableView,window:NSWindow,row:Int,flags:NSEvent.ModifierFlags,count:Int=1)->NSEvent {
    let rect=table.rect(ofRow:row),point=table.convert(NSPoint(x:20,y:rect.midY),to:nil)
    guard let event=NSEvent.mouseEvent(with:type,location:point,modifierFlags:flags,timestamp:0,windowNumber:window.windowNumber,context:nil,eventNumber:1,clickCount:count,pressure:1) else {fatalError("Could not construct mouse event")}
    return event
  }
}

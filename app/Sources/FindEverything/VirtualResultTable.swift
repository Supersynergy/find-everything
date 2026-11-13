import AppKit
import SwiftUI

/// AppKit keeps per-row bookkeeping even when cell views are reused.
/// Bound that bookkeeping while retaining global result coordinates.
struct ResultRowWindow {
  static let capacity=10_000
  var offset=0
  var total=0
  var count:Int {min(Self.capacity,max(0,total-offset))}
  mutating func include(_ row:Int,total:Int) {
    self.total=max(0,total)
    offset=min(offset,max(0,self.total-Self.capacity))
    if row<offset || row>=offset+count {offset=max(0,min(row-Self.capacity/2,self.total-Self.capacity))}
  }
  func global(_ local:Int)->Int {offset+local}
  func local(_ global:Int)->Int {global-offset}
}

/// Read-only cells let the native table receive mouse selection and drag events.
private final class ResultHostingView:NSHostingView<AnyView> {
  override func hitTest(_ point:NSPoint) -> NSView? {nil}
}
private final class ResultTableView:NSTableView {
  var menuForRow:((Int)->NSMenu?)?
  var beginMouseSelection:((Int)->Bool)?
  override func mouseDown(with event:NSEvent) {
    let row=row(at:convert(event.locationInWindow,from:nil))
    if row>=0,beginMouseSelection?(row)==false {return}
    super.mouseDown(with:event)
  }
  override func menu(for event:NSEvent) -> NSMenu? {
    let row=row(at:convert(event.locationInWindow,from:nil))
    guard row>=0 else {return nil}
    if !selectedRowIndexes.contains(row) {selectRowIndexes(IndexSet(integer:row),byExtendingSelection:false)}
    return menuForRow?(row)
  }
}

struct VirtualResultTable: NSViewRepresentable {
  @EnvironmentObject var m: Model
  let row: (FEItem, Int) -> AnyView

  func makeCoordinator() -> Coordinator { Coordinator(self) }
  func makeNSView(context: Context) -> NSScrollView {
    let scroll = NSScrollView()
    let table = ResultTableView()
    table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("result")))
    table.headerView = nil; table.intercellSpacing = .zero
    table.style = .plain
    table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
    table.selectionHighlightStyle = .none; table.focusRingType = .none
    table.allowsEmptySelection = false;table.allowsMultipleSelection=true
    table.setDraggingSourceOperationMask(.copy,forLocal:false)
    table.dataSource = context.coordinator; table.delegate = context.coordinator
    table.target=context.coordinator;table.doubleAction=#selector(Coordinator.openDoubleClicked(_:))
    table.menuForRow = {[weak coordinator=context.coordinator] row in coordinator?.menu(row:row)}
    table.beginMouseSelection = {[weak coordinator=context.coordinator] row in
      coordinator.map{$0.parent.m.beginMouseSelection($0.window.global(row))} ?? false
    }
    table.setAccessibilityLabel("All search results")
    m.focusResultsField = { [weak table] in if let table {table.window?.makeFirstResponder(table)} }
    scroll.documentView = table; scroll.hasVerticalScroller = true
    scroll.hasHorizontalScroller = false; scroll.autohidesScrollers = false
    scroll.scrollerStyle = .legacy
    scroll.contentView.postsBoundsChangedNotifications = true
    context.coordinator.observe(scroll)
    return scroll
  }
  func updateNSView(_ scroll: NSScrollView, context: Context) {
    context.coordinator.parent = self
    context.coordinator.update(scroll)
  }

  @MainActor final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
    var parent: VirtualResultTable
    private var observation: NSObjectProtocol?
    private var identity = -1, revision = -1, keyboard = -1
    private var selected = -1, display: DisplayPreferences?, pins: [String] = []
    private var selection=IndexSet()
    private var updating = false
    private(set) var window=ResultRowWindow()
    private var menuActions:[String:()->Void]=[:]
    init(_ parent: VirtualResultTable) { self.parent = parent }
    deinit { if let observation { NotificationCenter.default.removeObserver(observation) } }
    func observe(_ scroll: NSScrollView) {
      observation = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { [weak self, weak scroll] _ in
        MainActor.assumeIsolated { if let scroll { self?.requestViewport(scroll) } }
      }
    }
    func numberOfRows(in tableView: NSTableView) -> Int { window.count }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
      let row=window.global(row)
      let id = NSUserInterfaceItemIdentifier("result-row")
      let view = tableView.makeView(withIdentifier: id, owner: self) as? ResultHostingView ?? ResultHostingView(rootView: AnyView(EmptyView()))
      view.identifier = id
      if let item = parent.m.cachedResult(at: row) { view.rootView = parent.row(item, row) }
      else { view.rootView = AnyView(Text("…").font(.system(size: parent.m.display.fontSize)).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14).accessibilityLabel("Result \(row + 1) loading")) }
      return view
    }
    func tableViewSelectionDidChange(_ notification: Notification) {
      guard !updating,let table=notification.object as? NSTableView,!table.selectedRowIndexes.isEmpty else {return}
      let lead=table.clickedRow>=0 && table.selectedRowIndexes.contains(table.clickedRow) ? table.clickedRow : table.selectedRow
      parent.m.selectRows(IndexSet(table.selectedRowIndexes.map{window.global($0)}),lead:window.global(lead))
    }
    func tableView(_ tableView:NSTableView,pasteboardWriterForRow row:Int) -> NSPasteboardWriting? {
      guard parent.m.canInteractWithResults,tableView.selectedRowIndexes.count<=1000,
        tableView.selectedRowIndexes.allSatisfy({parent.m.cachedResult(at:window.global($0)) != nil}) else {return nil}
      return parent.m.cachedResult(at:window.global(row)).map{NSURL(fileURLWithPath:$0.path)}
    }
    @objc func openDoubleClicked(_ sender:Any?) {if parent.m.canInteractWithResults {parent.m.openSelection()}}
    @objc private func invokeMenu(_ sender:NSMenuItem) {
      guard let key=sender.representedObject as? String else {return}
      menuActions[key]?()
    }
    private func menuItem(_ title:String,_ action:@escaping ()->Void) -> NSMenuItem {
      let key=UUID().uuidString;menuActions[key]=action
      let item=NSMenuItem(title:title,action:#selector(invokeMenu(_:)),keyEquivalent:"")
      item.target=self;item.representedObject=key;return item
    }
    func menu(row:Int) -> NSMenu? {
      let row=window.global(row)
      let m=parent.m
      guard m.canInteractWithResults else {return nil}
      guard let result=m.cachedResult(at:row) else {m.requestResults(row..<(row+1));return nil}
      menuActions.removeAll()
      let menu=NSMenu(),count=m.selectedRows.count
      menu.addItem(menuItem(count>1 ? "Open \(count) Selected Files" : "Open") {m.openSelection()})
      let with=NSMenuItem(title:"Open With",action:nil,keyEquivalent:""),apps=NSMenu(title:"Open With")
      for app in NSWorkspace.shared.urlsForApplications(toOpen:result.url).prefix(12) {
        apps.addItem(menuItem(app.deletingPathExtension().lastPathComponent) {m.openSelection(with:app)})
      }
      if apps.numberOfItems>0 {apps.addItem(.separator())}
      apps.addItem(menuItem("Other…") {m.chooseApplicationForSelection()})
      with.submenu=apps;menu.addItem(with)
      menu.addItem(menuItem("Quick Look") {m.performSelected(.preview)})
      menu.addItem(menuItem("Open Containing Folder") {m.openSelectionFolder()})
      menu.addItem(menuItem("Show in Finder") {m.revealSelection()})
      menu.addItem(menuItem("Copy Path\(count>1 ? "s" : "")") {m.copySelectionPaths()})
      menu.addItem(menuItem("Filter by Selected File Types") {m.filterSelectionTypes()})
      if count==1 {
        menu.addItem(.separator())
        menu.addItem(menuItem("Search in This Folder") {m.searchInFolder(result.path)})
        menu.addItem(menuItem("Open in Terminal") {m.openTerminal(result.path)})
        menu.addItem(menuItem("Copy Name") {m.copyName(result.path)})
        menu.addItem(menuItem("Copy File") {m.copyFile(result.path)})
        menu.addItem(menuItem("Copy Contents") {m.copyContents(result.path)})
        menu.addItem(menuItem(m.pinnedSet.contains(result.path) ? "Remove from Favorites" : "Add to Favorites") {m.togglePin(result.path)})
        menu.addItem(.separator())
        menu.addItem(menuItem("Duplicate") {m.duplicate(result.path)})
        menu.addItem(menuItem("Compress") {m.compress(result.path)})
        menu.addItem(menuItem("Get Info") {m.getInfo(result.path)})
        menu.addItem(menuItem("Move to Trash") {m.trash(result.path)})
      }
      return menu
    }
    func update(_ scroll: NSScrollView) {
      guard let table = scroll.documentView as? NSTableView else { return }
      updating = true; defer { updating = false }
      let model = parent.m
      let oldOffset=window.offset
      if identity != model.resultIdentity {window.offset=0}
      window.include(keyboard != model.keyboardSelection ? model.selected : window.offset,total:model.resultCount)
      let shifted=oldOffset != window.offset
      table.setAccessibilityHelp("Results \(window.offset+1)–\(window.offset+window.count) of \(model.resultCount). Use First, Last or Go to result to jump; scrolling continues into adjacent ranges.")
      let height = (model.display.compact ? max(28, model.display.fontSize + 15) : max(44, model.display.fontSize * 2 + 22)) + (model.hasResultGroups ? 20 : 0)
      if table.rowHeight != height { table.rowHeight = height }
      if identity != model.resultIdentity || shifted {
        identity = model.resultIdentity; table.reloadData(); scroll.contentView.scroll(to: .zero)
      } else if table.numberOfRows != window.count { table.noteNumberOfRowsChanged() }
      if revision != model.virtualRevision || selected != model.selected || selection != model.selectedRows || display != model.display || pins != model.pinnedPaths {
        revision = model.virtualRevision
        selected=model.selected;selection=model.selectedRows;display=model.display;pins=model.pinnedPaths
        let visible = table.rows(in: scroll.contentView.bounds)
        if visible.location != NSNotFound, visible.length > 0 {
          table.reloadData(forRowIndexes: IndexSet(integersIn: visible.location..<min(window.count, NSMaxRange(visible))), columnIndexes: IndexSet(integer: 0))
        }
      }
      let visibleSelection=model.selectedRows.intersection(IndexSet(integersIn:window.offset..<(window.offset+window.count)))
      let valid=IndexSet(visibleSelection.map{window.local($0)})
      if table.selectedRowIndexes != valid {table.selectRowIndexes(valid,byExtendingSelection:false)}
      if keyboard != model.keyboardSelection {
        keyboard = model.keyboardSelection
        if model.resultCount > 0 { table.scrollRowToVisible(window.local(model.selected)) }
      }
      if model.resultFocused,!model.showOptions,!model.editingColumnFilter,!model.showActions,!model.showHelp,
        let window=table.window,window.firstResponder !== table {window.makeFirstResponder(table)}
      requestViewport(scroll)
    }
    private func requestViewport(_ scroll: NSScrollView) {
      guard let table = scroll.documentView as? NSTableView, parent.m.resultCount > 0 else { return }
      let range = table.rows(in: scroll.contentView.bounds)
      guard range.location != NSNotFound, range.length > 0 else { return }
      let first=window.global(range.location),last=min(parent.m.resultCount,window.global(NSMaxRange(range)))
      if !updating,window.total>ResultRowWindow.capacity {
        let direction = range.location<40 && window.offset>0 ? -1 : NSMaxRange(range)>window.count-40 && window.offset+window.count<window.total ? 1 : 0
        if direction != 0 {
          updating=true
          window.offset=max(0,min(window.offset+direction*ResultRowWindow.capacity/2,window.total-ResultRowWindow.capacity))
          table.reloadData()
          table.selectRowIndexes(IndexSet(parent.m.selectedRows.intersection(IndexSet(integersIn:window.offset..<(window.offset+window.count))).map{window.local($0)}),byExtendingSelection:false)
          scroll.contentView.scroll(to:NSPoint(x:0,y:table.rect(ofRow:window.local(first)).minY))
          scroll.reflectScrolledClipView(scroll.contentView)
          updating=false
        }
      }
      parent.m.requestResults(first..<last)
    }
  }
}

@MainActor enum ResultIcons {
  private static let cache: NSCache<NSString, NSImage> = {
    let cache = NSCache<NSString, NSImage>(); cache.countLimit = 512; cache.totalCostLimit = 2 * 1024 * 1024; return cache
  }()
  static func icon(for path: String) -> NSImage {
    if let value = cache.object(forKey: path as NSString) { return value }
    let value = NSImage(size: NSSize(width: 32, height: 32))
    value.lockFocus(); NSWorkspace.shared.icon(forFile: path).draw(in: NSRect(x: 0, y: 0, width: 32, height: 32)); value.unlockFocus()
    cache.setObject(value, forKey: path as NSString, cost: 4096)
    return value
  }
}

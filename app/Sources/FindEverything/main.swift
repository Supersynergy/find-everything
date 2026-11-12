import SwiftUI
import AppKit
import Carbon
import Foundation
import Darwin
import UniformTypeIdentifiers

// MARK: - Paths & tool discovery

enum FEDirs {
  static let support = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/FindEverything")
  static let binDir = support.appendingPathComponent("bin")
}

func toolPath(_ name: String) -> String? {
  let candidates = (name == "fe" ? [Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/fe").path, NSHomeDirectory() + "/.local/bin/fe"] : []) + [
    FEDirs.binDir.appendingPathComponent(name).path,
    "/opt/homebrew/bin/\(name)",
    "/usr/local/bin/\(name)",
    "/usr/bin/\(name)",
    NSHomeDirectory() + "/.local/bin/\(name)",
    NSHomeDirectory() + "/bin/\(name)",
  ]
  return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
}

// MARK: - Search model

struct FEScope: RawRepresentable, Hashable, Identifiable {
  let rawValue: String
  init?(rawValue: String) {
    guard rawValue.range(of: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$", options: .regularExpression) != nil else { return nil }
    self.rawValue = rawValue
  }
  static let home = FEScope(rawValue: "home")!
  static let downloads = FEScope(rawValue: "downloads")!
  static let documents = FEScope(rawValue: "documents")!
  static let applications = FEScope(rawValue: "applications")!
  static let all = FEScope(rawValue: "all")!
  static let custom = FEScope(rawValue: "custom")!
  static let allCases: [FEScope] = [.home, .downloads, .documents, .applications, .all, .custom]
  var id: String { rawValue }
  var label: String {
    switch self {
    case .home: "Home"
    case .downloads: "Downloads"
    case .documents: "Documents"
    case .applications: "Applications"
    case .all: "All (/)"
    case .custom: "Custom"
    case _ where rawValue == "everything": "All indexed files"
    default: rawValue
    }
  }
}

struct FEItem: Identifiable, Hashable {
  let path: String
  var indexedSize: Double? = nil
  var indexedMtime: Double? = nil
  var indexedDirectory: Bool? = nil
  var id: String { path }
  var url:URL {URL(fileURLWithPath:path)}
  var name: String { (path as NSString).lastPathComponent }
  var dir: String {
    let d = (path as NSString).deletingLastPathComponent
      .replacingOccurrences(of: NSHomeDirectory(), with: "~")
    if d.count <= 64 { return d }
    let parts = d.split(separator: "/").map(String.init)
    guard parts.count > 3 else { return d }
    return parts.prefix(2).joined(separator: "/") + "/…/"
      + parts.suffix(2).joined(separator: "/")
  }
}

@MainActor
final class Model: ObservableObject {
  @Published var display = DisplayPreferences.load() { didSet { if display != oldValue { display.persist() } } }
  @Published var viewOptions=SearchViewOptions.load() {didSet {
    guard viewOptions != oldValue else {return};viewOptions.persist()
    resultCache.budget=resultBudget
    if viewOptions.needsSearchRefresh(comparedTo:oldValue) {onQueryChange(query)}
  }}
  @Published var openingPreferences=OpeningPreferences.load() {didSet {if openingPreferences != oldValue {openingPreferences.persist()}}}
  @Published var savedSearches = SavedSearch.load()
  @Published var query = ""
  @Published var items: [FEItem] = []
  @Published private(set) var virtualRevision = 0
  @Published private(set) var resultIdentity = 0
  private var resultCache = VirtualResults<FEItem>()
  private var wantedResults = 0..<0
  private var resultTask: Task<Void, Never>?
  private struct QueryView {let items:[FEItem];let total:Int?;let snapshot:String?;let ms:Int;let bytes:Int}
  private var queryViews:[String:QueryView]=[:]
  private var queryOrder:[String]=[]
  private var displayedQuery=""
  private var startupView:WarmResults?
  @Published private(set) var showingStartupCache=false
  private var viewKey:String {scope.rawValue+"\n"+SearchQueryOptions.tokens(viewOptions.effectiveQuery(query,learning:display.habitRanking)).joined(separator:" ")}
  private var requestGate=SearchRequestGate()
  private var resultBudget:Int {viewOptions.cacheMiB*1024*1024-queryViews.values.reduce(0){$0+$1.bytes}}
  private var startupFile:URL {FEDirs.support.appendingPathComponent("startup-view.json")}
  var resultCount: Int { totalMatches ?? items.count }
  var canInteractWithResults:Bool {displayedQuery==viewKey && !searching && !indexing && resultCount>0}
  func cachedResult(at row: Int) -> FEItem? { resultCache.value(at: row) }
  @Published var recents: [FEItem] = []
  @Published var selected = 0 {didSet {if selectedRows.count<=1 {selectionDidChange?()}}}
  @Published private(set) var selectedRows = IndexSet(integer:0)
  @Published private(set) var selectionNeedsConfirmation=false
  private var selectionAnchor = 0
  private var selectionWasExplicit=false
  private var deferredSelectionRefresh=false
  private static let selectionRefreshMessage="Results changed; updates are paused while multiple files are selected."
  @Published var inputFocus:ResultInputFocus = .search
  var resultFocused:Bool {inputFocus == .results}
  var focusSearchField:((Bool)->Void)?
  var focusResultsField:(()->Void)?
  private var pendingQuickAction:(row:Int,generation:Int,action:SelectedQuickAction)?
  private var pendingEnd=false
  private var pendingEndAction:SelectedQuickAction?
  func focusSearch(selectAll:Bool=false) {inputFocus = .search;focusSearchField?(selectAll)}
  func focusResults() {inputFocus = .results;focusResultsField?()}
  @Published var keyboardSelection = 0
  @Published var windowMode = UserDefaults.standard.bool(forKey: "windowMode")
  @Published var showDockIcon = UserDefaults.standard.object(forKey:"showDockIcon") as? Bool ?? true
  @Published var showOptions = false
  @Published var columnFilter:ResultColumn?
  @Published var showSortBar=false
  @Published var editingColumnFilter=false
  @Published var autoUpdate = UserDefaults.standard.object(forKey: "autoUpdate") as? Bool ?? true
  @Published var liveNote = "Checking automatic updates…"
  @Published var liveProblem: String?
  private var liveRevision: String?
  private var checkingLive = false
  private var refreshing=false
  private var lastLivePoll=Date.distantPast
  var updateLiveService: (() -> Void)?
  @Published var searchNote = ""
  @Published private(set) var inputHint:String?
  @Published private(set) var unknownProperties=0
  @Published var totalMatches: Int?
  @Published private(set) var resultIsProvisional=false
  @Published var windowStart = 0
  private var resultSnapshot: String?
  private var resultIsSemantic = false
  private var resultHasExplicitSort = false
  private(set) var interactionEvents: [[String: Any]] = []
  var toggleWindowMode: (() -> Void)?
  var updateDockVisibility: (() -> Void)?
  var showQuickPreview:((String)->Void)?
  var showQuickPreviews:(([String])->Void)?
  var selectionDidChange:(()->Void)?
  #if FE_NATIVE_TESTS
  var testWebAction:((String)->Void)?
  var testTrashAction:((String)->Void)?
  var testRunTool:(([String]) async throws -> String)?
  var testExecutable:String?
  var testProcessEnvironment:[String:String]?
  #endif
  var ensureSearchService: (() -> Void)?

  func select(_ index: Int, trigger: SelectionTrigger) {
    guard ResultNavigation.canEnterResults(count:resultCount,queryPending:searching) else {return}
    focusResults();selectionNeedsConfirmation=false;selectionWasExplicit=true
    pendingEnd=false;pendingEndAction=nil
    let result = ResultNavigation.select(index, count: resultCount, trigger: trigger)
    if selected != result.index {pendingQuickAction=nil}
    selectionAnchor=result.index
    selectedRows=resultCount>0 ? IndexSet(integer:result.index) : IndexSet()
    selected = result.index
    if result.scroll { keyboardSelection += 1 }
    if resultCount > 0 { requestResults(selected..<(selected+1)) }
    recordInteraction("nav", trigger: trigger == .keyboard ? "keyboard" : "click")
    resumeDeferredSelectionRefresh()
  }
  func beginMouseSelection(_ row:Int) -> Bool {
    guard canInteractWithResults else {return false}
    selectionWasExplicit=true
    if selectionNeedsConfirmation {selectRows(IndexSet(integer:row),lead:row)} else {focusResults()}
    return true
  }
  func selectRows(_ rows:IndexSet,lead:Int) {
    guard canInteractWithResults else {return}
    let valid=ResultSelection.bounded(rows,count:resultCount)
    guard !valid.isEmpty else {return}
    focusResults();selectionNeedsConfirmation=false;selectionWasExplicit=true;pendingEnd=false;pendingEndAction=nil;pendingQuickAction=nil
    selectedRows=valid
    selected=valid.contains(lead) ? lead : (valid.last ?? 0)
    selectionAnchor=selected
    requestResults(selected..<(selected+1))
    recordInteraction("nav",trigger:"click")
    resumeDeferredSelectionRefresh()
  }
  func extendSelection(_ direction:Int) {
    guard resultCount>0 else {return}
    selectionNeedsConfirmation=false;selectionWasExplicit=true
    let next=max(0,min(selected+direction,resultCount-1))
    selectedRows=ResultSelection.range(anchor:selectionAnchor,through:next,count:resultCount)
    selected=next;keyboardSelection += 1
    requestResults(next..<(next+1))
    resumeDeferredSelectionRefresh()
  }
  func performSelected(_ action:SelectedQuickAction) {
    guard !selectionNeedsConfirmation else {actionFailure("Results changed; select a file again");return}
    selectionWasExplicit=true
    if selectedRows.count>1 && (action == .open || action == .preview) {
      withSelectedItems {items in
        if action == .open {self.openItems(items)}
        else {self.showQuickPreviews?(items.map(\.path))}
      }
      return
    }
    if pendingEnd {pendingEndAction = pendingEndAction == action && action == .preview ? nil : action;return}
    if resultCount==0,!searching,displayedQuery==viewKey {return}
    if let item=currentItem {pendingQuickAction=nil;runSelected(action,item);return}
    let row=displayedQuery==viewKey ? selected : 0
    if action == .preview,pendingQuickAction?.row==row,pendingQuickAction?.action == .preview {pendingQuickAction=nil;return}
    pendingQuickAction=(row,searchGeneration,action)
    if resultCount>0 {requestResults(row..<(row+1))}
  }
  private func runSelected(_ action:SelectedQuickAction,_ item:FEItem) {
    switch action {case .preview:quickLook(item.path);case .open:open(item.path);case .folder:searchInFolder(item.path)}
  }
  private func flushQuickAction() {
    guard let pending=pendingQuickAction,pending.generation==searchGeneration,pending.row==selected,let item=currentItem else {return}
    pendingQuickAction=nil;runSelected(pending.action,item)
  }

  func recordInteraction(_ event: String, trigger: String) {
    interactionEvents.append(["event": event, "trigger": trigger, "ts": Date().timeIntervalSince1970])
    if interactionEvents.count > 128 { interactionEvents.removeFirst(interactionEvents.count - 128) }
  }
  @Published var showActions = false
  @Published var scope: FEScope = FEScope(
    rawValue: UserDefaults.standard.string(forKey: "scope") ?? "home"
  ) ?? .home
  @Published var searching = false
  @Published var indexing = false
  @Published var indexingStatus = "Building index…"
  @Published var indexProgress: IndexingProgress?
  @Published var indexingTarget = ""
  @Published private var requestedIndexPause: Bool?
  @Published private var indexControlReady=false
  var indexPausePending: Bool {requestedIndexPause != nil}
  var canPauseIndexing: Bool {indexControlReady && indexProgress?.phase != .complete && indexProgress != nil && indexProc?.isRunning == true}

  func toggleIndexingPause() {
    guard canPauseIndexing,!indexPausePending,let progress=indexProgress,let running=indexProc else {return}
    if kill(running.processIdentifier,SIGUSR2)==0 {requestedIndexPause = !progress.paused}
    else {errorMessage="Could not change indexing state. Retry or cancel this run."}
  }
  private func acceptIndexProgress(_ progress: IndexingProgress,from running: Process) {
    guard indexProc === running else {return}
    indexProgress=progress;indexControlReady=true
    if requestedIndexPause == progress.paused {requestedIndexPause=nil}
  }
  private func finishIndexing() {
    indexing=false;indexProgress=nil;requestedIndexPause=nil;indexControlReady=false;indexingTarget="";indexingStatus="Building index…"
  }
  private var enrichmentTask: Task<Void, Never>?
  private var indexProc: Process?
  @Published var showDetail = UserDefaults.standard.bool(forKey:"showDetail") { didSet { UserDefaults.standard.set(showDetail,forKey:"showDetail") } }
  @Published var setupNeeded = false
  @Published var setupLog = "Checking tools…"
  @Published var setupRunning = false
  @Published var savedScopes: [FEScope] = []
  @Published var indexSummaries: [String: String] = [:]
  private var indexedScopes: Set<FEScope>?
  var needsIndex: Bool { indexedScopes.map { !$0.contains(scope) } ?? false }
  @Published var errorMessage: String?
  @Published var actionError: String?
  @Published var shortcutWarning: String?
  var availableScopes: [FEScope] { FEScope.allCases + savedScopes }
  @Published var actSel = 0
  @Published var actMenu: ActMenu = .root
  @Published var actFilter = ""
  @Published var toast = ""
  var openWithApps: [URL] = []
  private var toastTask: Task<Void, Never>?

  /// Brief footer confirmation — the little "copied" nod launchers give.
  func showToast(_ s: String) {
    toast = s
    toastTask?.cancel()
    toastTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 1_400_000_000)
      if !Task.isCancelled { toast = "" }
    }
  }
  /// Set by the delegate; actions that hand over to another app close the panel.
  var hidePanel: (() -> Void)?

  var fePath: String? {
    #if FE_NATIVE_TESTS
    if let testExecutable {return testExecutable}
    #endif
    return toolPath("fe")
  }
  private var searchTask: Task<Void, Never>?
  private var foregroundFetch:Task<SearchReply,Error>?
  private var foregroundID=UUID()
  private var searchGeneration = 0
  private var metaCache: [String: (at: Date, attrs: [FileAttributeKey: Any])] = [:]

  // User habits live in a JSON file under Application Support — app data,
  // not a preference. Works regardless of how the binary was launched and
  // stays inspectable/shareable with the fe CLI.
  static var opensFile: URL {
    FEDirs.support.appendingPathComponent("opens.json")
  }
  static var pinsFile: URL {
    if let file=ProcessInfo.processInfo.environment["FE_FAVORITES_FILE"] {return URL(fileURLWithPath:file)}
    return FEDirs.support.appendingPathComponent("pins.json")
  }
  static var historyFile: URL {
    FEDirs.support.appendingPathComponent("history.json")
  }
  /// Last queries (newest first) — ↑ at the top row cycles through them.
  @Published var history: [String] = []
  var histPos = -1
  private var histDraft = ""

  func loadHistory() {
    history = (try? JSONDecoder().decode(
      [String].self, from: Data(contentsOf: Model.historyFile))) ?? []
  }
  func recordQuery(_ q: String) {
    let t = q.trimmingCharacters(in: .whitespaces)
    guard display.rememberHistory, t.count >= 2 else { return }
    history.removeAll { $0 == t }
    history.insert(t, at: 0)
    if history.count > 30 { history = Array(history.prefix(30)) }
    if let d = try? JSONEncoder().encode(history) {
      try? FileManager.default.createDirectory(
        at: FEDirs.support, withIntermediateDirectories: true)
      try? d.write(to: Model.historyFile, options: .atomic)
    }
  }
  func historyUp() -> Bool {
    if histPos == -1 {
      guard !history.isEmpty else { return false }
      histDraft = query
      histPos = 0
    } else if histPos < history.count - 1 {
      histPos += 1
    } else { return true }
    query = history[histPos]
    onQueryChange(query)
    return true
  }
  func historyDown() -> Bool {
    guard histPos >= 0 else { return false }
    histPos -= 1
    query = histPos == -1 ? histDraft : history[histPos]
    onQueryChange(query)
    return true
  }
  /// Last query removed by Esc / ⌘⌫ / the cancel button — ⌘Z puts it back.
  private(set) var lastClearedQuery = ""
  /// Clears the line, keeps the caret in the field and remembers the text
  /// so an accidental clear is one ⌘Z away from coming back.
  func clearQuery() {
    guard !query.isEmpty else { focusSearch(); return }
    lastClearedQuery = query
    query = ""
    histPos = -1
    onQueryChange("")
    focusSearch()
  }
  @discardableResult func restoreClearedQuery() -> Bool {
    guard query.isEmpty, !lastClearedQuery.isEmpty else { return false }
    query = lastClearedQuery
    lastClearedQuery = ""
    onQueryChange(query)
    focusSearch()
    return true
  }
  /// Pinned items float above recents and are boosted over other results.
  @Published private(set) var pinnedPaths: [String] = []
  private var pinsStamp:String?
  var pinnedSet: Set<String> { Set(pinnedPaths) }
  @Published var lastMs = 0
  @Published var showHelp = false

  @discardableResult func loadPins() -> Bool {
    let attrs=try? FileManager.default.attributesOfItem(atPath:Model.pinsFile.path)
    let modified=(attrs?[.modificationDate] as? Date)?.timeIntervalSinceReferenceDate ?? 0
    let stamp="\(modified):\(attrs?[.size] ?? 0):\(attrs?[.systemFileNumber] ?? 0)"
    guard stamp != pinsStamp else {return false};pinsStamp=stamp
    let values:[String]
    if attrs == nil {values=[]}
    else {
      guard let size=attrs?[.size] as? NSNumber,size.intValue<=2*1024*1024,
        let data=try? Data(contentsOf:Model.pinsFile),let decoded=try? JSONDecoder().decode([String].self,from:data),decoded.count<=10000 else {return false}
      values=decoded
    }
    guard pinnedPaths != values else {return false};pinnedPaths=values;return true
  }

  func togglePin(_ p: String) {
    let remove=pinnedSet.contains(p)
    Task {
      do {
        let output=try await runTool(["favorites",remove ? "remove" : "add","--json","--",p])
        struct Reply:Decodable {let paths:[String]}
        pinnedPaths=try JSONDecoder().decode(Reply.self,from:Data(output.utf8)).paths
        showToast(remove ? "Removed from favorites" : "Added to favorites")
        loadRecents()
        onQueryChange(query,preserveSelection:true)
      }catch {showToast("Favorite could not be saved: \(error.localizedDescription)")}
    }
  }
  private var opens: [String: Double] {
    guard let data = try? Data(contentsOf: Model.opensFile),
          let d = try? JSONSerialization.jsonObject(with: data)
              as? [String: Double]
    else { return [:] }
    return d
  }

  func recordOpen(_ p: String) {recordOpened([p])}
  private func recordOpened(_ paths:[String]) {
    saveOpens(OpenRecents.updating(opens,adding:paths,at:Date().timeIntervalSince1970))
  }

  private func saveOpens(_ d: [String: Double]) {
    try? FileManager.default.createDirectory(
      at: FEDirs.support, withIntermediateDirectories: true)
    if let data = try? JSONSerialization.data(
      withJSONObject: d, options: [.sortedKeys]) {
      try? data.write(to: Model.opensFile, options: .atomic)
    }
    loadRecents()
  }

  func loadRecents() {
    let fm = FileManager.default
    let pins = pinnedPaths.filter { fm.fileExists(atPath: $0) }
    let rest = opens.sorted { $0.value > $1.value }
      .map(\.key)
      .filter { fm.fileExists(atPath: $0) && !pinnedSet.contains($0) }
      .prefix(10)
    recents = Array((pins + rest).prefix(12)).map { FEItem(path: $0) }
  }

  // Raycast-style tiers: Pinned → Recently Used → Applications → Files.
  // Order within a tier keeps the engine's fuzzy ranking (stable bucket
  // sort — Array.sorted is not guaranteed stable).
  static let tierTitles = [
    "Pinned", "Recently Used", "Applications", "Files & Folders",
  ]
  func tier(_ it: FEItem) -> Int {
    if pinnedSet.contains(it.path) { return 0 }
    if opens[it.path] != nil { return 1 }
    if it.path.hasSuffix(".app") { return 2 }
    return 3
  }
  /// Section header to render above row i (nil = none).
  func headerBefore(_ i: Int) -> String? {
    guard hasResultGroups else { return nil }
    let l = visibleItems
    guard i < l.count else { return nil }
    let t = tier(l[i])
    if i == 0 || tier(l[i - 1]) != t { return Model.tierTitles[t] }
    return nil
  }
  var hasResultGroups:Bool {display.groupResults && display.habitRanking && !resultIsSemantic && !resultHasExplicitSort && !query.trimmingCharacters(in:.whitespaces).isEmpty}
  func habitBoost(_ list: [FEItem]) -> [FEItem] {
    guard display.habitRanking else { return list }
    let d = opens
    var tiers: [[FEItem]] = [[], [], [], []]
    for it in list { tiers[tier(it)].append(it) }
    tiers[0].sort {
      (pinnedPaths.firstIndex(of: $0.path) ?? 0)
        < (pinnedPaths.firstIndex(of: $1.path) ?? 0)
    }
    tiers[1].sort { (d[$0.path] ?? 0) > (d[$1.path] ?? 0) }
    return tiers.flatMap { $0 }
  }

  func meta(for p: String) -> [FileAttributeKey: Any]? {
    if let m = metaCache[p], -m.at.timeIntervalSinceNow < 300 { return m.attrs }
    let attrs = try? FileManager.default.attributesOfItem(atPath: p)
    if let attrs {
      if metaCache.count >= 1024 { metaCache.removeAll(keepingCapacity: true) }
      metaCache[p] = (Date(), attrs)
    }
    return attrs
  }

  func bootstrap() {
    // DisplayPreferences already defaults new installs to instant search; keep saved choices.
    if !UserDefaults.standard.bool(forKey:"instantSearch.v1") {UserDefaults.standard.set(true,forKey:"instantSearch.v1")}
    if let saved=WarmResults.load(startupFile,scope:scope.rawValue,query:viewOptions.effectiveQuery("",learning:display.habitRanking)) {
      startupView=saved;showingStartupCache=true
      items=saved.entries.map{FEItem(path:$0.path,indexedSize:$0.size,indexedMtime:$0.mtime,indexedDirectory:$0.directory)}
      totalMatches=saved.total;displayedQuery=viewKey
      resultCache.insert(items,at:0,cost:items.reduce(0){$0+$1.path.utf8.count*2+256})
      virtualRevision += 1
    }
    loadPins()
    loadHistory()
    loadRecents()
    let missing = ["fe"].filter { toolPath($0) == nil }
    if missing.isEmpty {
      setupNeeded = false
      ensureIndexIfNeeded()
    } else {
      setupNeeded = true
      setupLog = "Missing: \(missing.joined(separator: ", "))"
    }
  }

  func ensureIndexIfNeeded() {
    Task {
      await loadIndexes()
      if errorMessage == nil,let indexedScopes,!UserDefaults.standard.bool(forKey:"initialAllIndex.v1") {
        UserDefaults.standard.set(true,forKey:"initialAllIndex.v1")
        if !indexedScopes.contains(FEScope(rawValue:"all")!) {
          scope=FEScope(rawValue:"all")!;items=[];rebuild();return
        }
      }
      if errorMessage == nil {onQueryChange(query)}
    }
  }

  func loadIndexes() async {
    do {
      let out = try await runTool(["indexes", "--json"])
      struct SavedIndex: Decodable { let name: String; let paths: [String]; let count: Int?; let stale: Bool; let exists: Bool }
      let indexes = try JSONDecoder().decode([SavedIndex].self, from: Data(out.utf8))
      savedScopes = indexes.compactMap { FEScope(rawValue: $0.name) }
        .filter { !FEScope.allCases.contains($0) }
      indexSummaries = Dictionary(uniqueKeysWithValues: indexes.map { item in
        (item.name, "\(item.count.map { String($0) } ?? "0") base paths · \(item.exists ? (item.stale ? "older snapshot" : "snapshot") : "not indexed") · \(item.paths.joined(separator: ", ")) · exclusions / permissions apply")
      })
      let existing = indexes.filter(\.exists).compactMap { FEScope(rawValue: $0.name) }
      indexedScopes = Set(existing)
      if !existing.contains(scope), let fallback = existing.first(where: { $0.rawValue == "everything" }) ?? existing.first {
        scope = fallback
        UserDefaults.standard.set(fallback.rawValue, forKey: "scope")
      } else if !availableScopes.contains(scope) { scope = .home }
      errorMessage = nil
    } catch { errorMessage = error.localizedDescription }
  }

  func indexFolder() {
    guard !indexing else {return}
    let picker = NSOpenPanel()
    picker.title = "Index a folder or project"
    picker.message = "Include hidden, ignored and generated files, or select project source only. Explicit exclusions and permissions still apply."
    picker.prompt = "Index Folder"
    picker.canChooseFiles = false; picker.canChooseDirectories = true
    picker.allowsMultipleSelection = true
    let respectIgnore = NSButton(checkboxWithTitle: "Respect .gitignore and .ignore (project source only)", target: nil, action: nil)
    respectIgnore.sizeToFit()
    picker.accessoryView = respectIgnore
    picker.isAccessoryViewDisclosed = true
    guard picker.runModal() == .OK, let first = picker.urls.first else {
      if scope == .custom { scope = .home }
      return
    }
    let base = String(first.lastPathComponent.lowercased()
      .replacingOccurrences(of: "[^a-z0-9_-]", with: "-", options: .regularExpression)
      .trimmingCharacters(in: CharacterSet(charactersIn: "-_"))
      .prefix(40))
    let stem = base.isEmpty ? "folder" : base
    var name = stem, suffix = 2
    while availableScopes.contains(where: { $0.rawValue == name }) {
      name = "\(stem)-\(suffix)"; suffix += 1
    }
    let args = ["index", "--name", name, "--preset", respectIgnore.state == .on ? "project" : "folder", "--json", "--progress-json"]
      + (respectIgnore.state == .on ? [] : ["--exhaustive"])
      + picker.urls.flatMap { ["--path", $0.path] }
    indexing=true;errorMessage=nil;indexingTarget=name;indexProgress=IndexingProgress()
    enrichmentTask=Task {
      do {
        _ = try await runTool(args)
        await loadIndexes()
        if let selected = FEScope(rawValue: name) { scope = selected }
        showToast("Indexed \(name)")
      } catch {if !Task.isCancelled {errorMessage=error.localizedDescription}}
      finishIndexing()
      if errorMessage == nil && !Task.isCancelled {onQueryChange(query,force:true)}
    }
  }

  var selectionRefreshPaused:Bool {deferredSelectionRefresh}
  private func deferSelectionRefresh() {
    if !deferredSelectionRefresh {actionError=Self.selectionRefreshMessage}
    deferredSelectionRefresh=true;liveNote=Self.selectionRefreshMessage
  }
  func refreshDeferredResults() {
    guard deferredSelectionRefresh else {return}
    deferredSelectionRefresh=false;actionError=nil
    selectedRows=IndexSet();selectionNeedsConfirmation=true
    onQueryChange(query,preserveSelection:true,force:true)
  }
  private func resumeDeferredSelectionRefresh() {
    guard deferredSelectionRefresh,selectedRows.count<=1 else {return}
    deferredSelectionRefresh=false
    if actionError==Self.selectionRefreshMessage {actionError=nil}
    let generation=searchGeneration,key=viewKey
    DispatchQueue.main.async { [weak self] in
      guard let self,self.searchGeneration==generation,self.viewKey==key else {return}
      guard self.selectedRows.count<=1 else {self.deferredSelectionRefresh=true;return}
      self.onQueryChange(self.query,preserveSelection:true,force:true)
    }
  }
  func onQueryChange(_ q: String, preserveSelection: Bool = false,force:Bool=false) {
    if preserveSelection,displayedQuery==viewKey,selectedRows.count>1 {deferSelectionRefresh();return}
    if !preserveSelection || displayedQuery != viewKey {
      deferredSelectionRefresh=false;selectionNeedsConfirmation=false;selectionWasExplicit=false
      if actionError==Self.selectionRefreshMessage {actionError=nil}
    }
    guard requestGate.begin(viewKey,force:force || preserveSelection || errorMessage != nil) else {recordInteraction("query_reused",trigger:"duplicate");return}
    unknownProperties=0
    pendingQuickAction=nil;pendingEnd=false;pendingEndAction=nil
    let usePreview = !preserveSelection && queryViews[viewKey] == nil
    resultIsProvisional=false
    let hadSelection=preserveSelection && !selectedRows.isEmpty && resultCount>0
    let wasSelectionBlocked=selectionNeedsConfirmation
    let selectedPath = preserveSelection ? currentItem?.path : nil
    selectedRows=selectionNeedsConfirmation ? IndexSet() : (resultCount>0 ? IndexSet(integer:selected) : IndexSet())
    selectionAnchor=selected
    let initialSelection=selectedRows,initialLead=selected
    let requestedOffset = preserveSelection ? VirtualResults<FEItem>.offset(for:wantedResults.lowerBound) : 0
    let requestedLimit = VirtualResults<FEItem>.pageSize
    searchGeneration += 1
    let generation = searchGeneration
    resultTask?.cancel();resultTask=nil
    if !preserveSelection {
      wantedResults=0..<0
      if let cached=queryViews[viewKey] {
        resultCache.removeAll();resultCache.insert(cached.items,at:0,cost:cached.bytes)
        items=cached.items;totalMatches=cached.total;resultSnapshot=cached.snapshot;lastMs=cached.ms
        displayedQuery=viewKey;showingStartupCache=false;selected=0;selectedRows=resultCount>0 ? IndexSet(integer:0) : IndexSet();selectionAnchor=0;resultIdentity += 1;virtualRevision += 1
      }
    }
    // Query edits leave history mode — unless the edit IS the history
    // entry we just navigated to (text match beats a flag: onQueryChange
    // can fire twice — binding onChange plus an explicit call).
    let qt = q.trimmingCharacters(in: .whitespaces)
    if !(histPos >= 0 && histPos < history.count
         && history[histPos] == qt) {
      histPos = -1
    }
    searchTask?.cancel()
    foregroundFetch?.cancel()
    if searching {searching=false};refreshing=false
    if !preserveSelection {errorMessage=nil;searchNote=""}
    windowStart = requestedOffset
    let t = q.trimmingCharacters(in: .whitespaces)
    inputHint=nil
    guard !indexing else { items = []; selected = 0; return }
    // Path passthrough: a pasted or typed absolute/~/ path that exists
    // resolves directly — Enter opens it, no index needed.
    let expanded = (t as NSString).expandingTildeInPath
    if (t.hasPrefix("/") || t.hasPrefix("~")),
       FileManager.default.fileExists(atPath: expanded) {
      items = [FEItem(path: expanded)]
      resultCache.removeAll();displayedQuery=viewKey;resultIdentity += 1;showingStartupCache=false
      resultCache.insert(items,at:0,cost:expanded.utf8.count*2+256)
      totalMatches=1;virtualRevision += 1
      selectedRows=IndexSet(integer:0);selectionAnchor=0;selected = 0; keyboardSelection += 1
      if searching {searching=false}
      return
    }
    guard !needsIndex else {
      items=[];resultCache.removeAll();totalMatches=0;selectedRows=IndexSet();selected=0
      displayedQuery=viewKey;showingStartupCache=false;virtualRevision += 1
      errorMessage="\(scope.label) has no saved index. Choose an indexed scope or create this index explicitly."
      return
    }
    ensureSearchService?()
    inputHint=SearchQueryOptions.incompleteHint(q)
    if inputHint != nil {searching=true;return}
    if !preserveSelection {searching=true}
    searchTask = Task {
      defer {if generation==searchGeneration {if searching {searching=false};refreshing=false}}
      try? await Task.sleep(nanoseconds: UInt64(display.debounceMs) * 1_000_000)
      guard !Task.isCancelled else { return }
      if preserveSelection {refreshing=true} else {searching=true}
      let t0 = Date()
      var publishedPreview=false,preservedPreviewSelection=false
      do {
        recordInteraction("task_start", trigger: "query")
        var start = requestedOffset
        var reply = try await fetchForQuery(t,index:scope.rawValue,offset:start,limit:requestedLimit,generation:generation,preview:usePreview)
        guard !Task.isCancelled, generation == searchGeneration else { return }
        if reply.provisional == true {
          publishReply(reply,query:t,start:start,reset:true)
          publishedPreview=true;resultIsProvisional=true
          selectedRows=resultCount>0 ? IndexSet(integer:0) : IndexSet();selectionAnchor=0;selected=0;keyboardSelection += 1
          lastMs=Int(-t0.timeIntervalSinceNow*1000);searching=false
          flushQuickAction()
          guard generation==searchGeneration else {return}
          try await Task.sleep(nanoseconds:80_000_000)
          try Task.checkCancellation()
          reply = try await fetchForQuery(t,index:scope.rawValue,offset:start,limit:requestedLimit,generation:generation)
          guard !Task.isCancelled, generation == searchGeneration else { return }
        }
        if reply.paths.isEmpty, requestedOffset > 0 {
          start = VirtualResults<FEItem>.offset(for:max(0,(reply.coverage?.matched ?? 0)-1))
          reply = try await fetchForQuery(t,index:scope.rawValue,offset:start,limit:requestedLimit,generation:generation)
        }
        guard !Task.isCancelled, generation == searchGeneration else { return }
        let outcome=publishFinalReply(reply,query:t,start:start,publishedPreview:publishedPreview,preserveSelection:preserveSelection,initialSelection:initialSelection,initialLead:initialLead)
        guard outcome.published else {return}
        preservedPreviewSelection=outcome.retainedSelection
        if publishedPreview {searchNote += " Exact count ready after \(Int(-t0.timeIntervalSinceNow*1000))ms."}
        recordInteraction("task_success", trigger: "query")
      } catch {
        guard !Task.isCancelled, generation == searchGeneration else { return }
        pendingEnd=false;pendingEndAction=nil
        if preserveSelection {liveNote="Background refresh failed: \(error.localizedDescription)"}
        else {errorMessage=error.localizedDescription}
      }
      if publishedPreview,resultIsProvisional,selectedRows.count>1 {deferSelectionRefresh();return}
      if !preserveSelection && !publishedPreview {lastMs=Int(-t0.timeIntervalSinceNow*1000)}
      if !preserveSelection,!resultIsProvisional,displayedQuery==viewKey,!items.isEmpty {rememberView()}
      let matched=selectedPath.flatMap {path in items.firstIndex(where:{$0.path==path}).map{$0+windowStart}}
      if preservedPreviewSelection {
        // The exact reply already reconciled the user's selected paths.
      } else if preserveSelection && (wasSelectionBlocked || (hadSelection && matched == nil)) {
        selectedRows=IndexSet();selectionNeedsConfirmation=true
        actionFailure("Results changed; select a file again")
      } else {
        let restored=matched ?? (preserveSelection || publishedPreview ? min(selected,max(0,resultCount-1)) : 0)
        selectedRows=resultCount>0 ? IndexSet(integer:restored) : IndexSet()
        if selected != restored {selected=restored}
        selectionAnchor=restored
      }
      if resultCount==0,resultFocused {focusSearch()}
      flushQuickAction()
      guard generation==searchGeneration else {return}
      if !preserveSelection && !publishedPreview { keyboardSelection += 1 }
      if searching {searching=false}
      if pendingEnd && !resultIsProvisional {
        let action=pendingEndAction
        jumpBoundary(last:true)
        if let action {performSelected(action)}
      }
      requestResults(wantedResults.isEmpty ? startRange() : wantedResults)
    }
  }

  private func publishFinalReply(_ reply:SearchReply,query:String,start:Int,publishedPreview:Bool,preserveSelection:Bool,initialSelection:IndexSet,initialLead:Int) -> (published:Bool,retainedSelection:Bool) {
    let changedWhileRefreshing=preserveSelection && (selectedRows.count>1 || selectedRows != initialSelection || selected != initialLead)
    if !pendingEnd,!selectedRows.isEmpty,((publishedPreview && selectionWasExplicit) || changedWhileRefreshing) {
      let published=publishExactPreservingSelection(reply,query:query,start:start)
      return (published,published)
    }
    publishReply(reply,query:query,start:start,reset:!preserveSelection && !publishedPreview)
    resultIsProvisional=false
    return (true,false)
  }
  /// Reconcile by path before replacing a snapshot, never by old row index.
  private func publishExactPreservingSelection(_ reply:SearchReply,query:String,start:Int) -> Bool {
    let next=replyItems(reply,query:query,start:start)
    guard let mapping=ResultSelection.remap(selectedRows,lead:selected,cached:{self.cachedResult(at:$0)?.path},newPaths:next.map(\.path),offset:start) else {
      if selectedRows.count>1 {deferSelectionRefresh();return false}
      publishReply(reply,query:query,start:start,reset:false,prepared:next)
      resultIsProvisional=false;selectedRows=IndexSet();selectionNeedsConfirmation=true
      actionFailure("Results changed; select a file again")
      return true
    }
    publishReply(reply,query:query,start:start,reset:false,prepared:next)
    resultIsProvisional=false;selectedRows=mapping.rows
    if selected != mapping.lead {selected=mapping.lead}
    selectionAnchor=mapping.lead
    return true
  }
  private func replyItems(_ reply:SearchReply,query:String,start:Int) -> [FEItem] {
    let found=indexedItems(reply)
    let ordered=reply.snapshotId != nil || SearchQueryOptions.value("sort",in:query) != nil || start>0
    return reply.semantic == true || query.isEmpty || ordered ? found : habitBoost(found)
  }
  private func publishReply(_ reply:SearchReply,query:String,start:Int,reset:Bool,prepared:[FEItem]?=nil) {
    errorMessage=nil
    if reset {resultCache.removeAll();resultIdentity += 1}
    displayedQuery=viewKey;showingStartupCache=false;windowStart=start
    cacheSearchProperties(reply.properties ?? [])
    resultIsSemantic=reply.semantic == true
    resultHasExplicitSort=reply.snapshotId != nil || SearchQueryOptions.value("sort",in:query) != nil || start>0
    let updated=prepared ?? replyItems(reply,query:query,start:start)
    if items != updated {items=updated}
    if resultSnapshot != reply.snapshotId {resultCache.removeAll()}
    resultCache.budget=resultBudget
    if resultCache.insert(updated,at:start,cost:updated.reduce(0){$0+$1.path.utf8.count*2+256}) {virtualRevision += 1}
    if totalMatches != reply.coverage?.matched {totalMatches=reply.coverage?.matched}
    unknownProperties=reply.coverage?.metadataUnknown ?? 0
    resultSnapshot=reply.snapshotId
    var note=(reply.warnings ?? []).joined(separator:" ")
    if let normalized=reply.normalizedQuery,normalized != query {note="\(normalized)  \(note)"}
    if searchNote != note {searchNote=note}
  }

  private func rememberView() {
    let cost=items.reduce(0){$0+$1.path.utf8.count*2+256}
    guard cost<=1024*1024 else {return}
    let key=viewKey;queryOrder.removeAll{$0==key};queryViews.removeValue(forKey:key)
    while queryViews.count>=4 || queryViews.values.reduce(0,{$0+$1.bytes})+cost>4*1024*1024 {
      guard !queryOrder.isEmpty else {break};queryViews.removeValue(forKey:queryOrder.removeFirst())
    }
    queryViews[key]=QueryView(items:items,total:totalMatches,snapshot:resultSnapshot,ms:lastMs,bytes:cost);queryOrder.append(key)
    resultCache.budget=resultBudget
    if query.trimmingCharacters(in:.whitespaces).isEmpty,windowStart==0 {
      let first=startupView==nil
      startupView=WarmResults(scope:scope.rawValue,query:viewOptions.effectiveQuery("",learning:display.habitRanking),total:resultCount,entries:items.map{WarmResults.Entry(path:$0.path,size:$0.indexedSize,mtime:$0.indexedMtime,directory:$0.indexedDirectory)})
      if first {saveStartupView()}
    }
  }
  func saveStartupView() {
    do {try startupView?.save(startupFile)}catch {liveNote="Startup cache unavailable: \(error.localizedDescription)"}
  }

  func pollUpdates() async {
    guard autoUpdate,!checkingLive,!searching,!refreshing,!indexing,Date().timeIntervalSince(lastLivePoll)>=Double(viewOptions.refreshSeconds) else {return}
    lastLivePoll=Date()
    let favoritesChanged=loadPins()
    checkingLive = true; defer { checkingLive = false }
    let index = scope.rawValue, generation = searchGeneration
    do {
      let update = try await SearchSocket.updates(index: index)
      guard index == scope.rawValue, generation == searchGeneration, !searching, !indexing else { return }
      if liveProblem != update.problem {liveProblem=update.problem}
      let note=update.watching ? (update.pending ?? 0 > 0 ? "Updating changed file properties…" : "Automatic updates active") : "Automatic updates unavailable; reopen the app to retry"
      if liveNote != note {liveNote=note}
      let revision = index + update.revision
      if liveRevision != revision || favoritesChanged {queryViews.removeAll();queryOrder.removeAll()}
      if liveRevision != revision || (favoritesChanged && SearchQueryOptions.value("favorites",in:query)=="true") {onQueryChange(query,preserveSelection:true)}
      liveRevision = revision
    } catch {
      liveNote = "Automatic updates unavailable: \(error.localizedDescription)"
      liveRevision = nil
      ensureSearchService?()
    }
  }

  func setAutoUpdate(_ enabled: Bool) {
    autoUpdate = enabled; UserDefaults.standard.set(enabled, forKey:"autoUpdate")
    liveRevision = nil; liveNote = enabled ? "Starting automatic updates…" : "Automatic updates paused"
    updateLiveService?()
  }

  func saveSearch() {
    guard query.count <= 4096 else { return }
    guard !savedSearches.contains(where: { $0.query == query && $0.index == scope.rawValue }) else { showToast("Search already saved"); return }
    guard savedSearches.count < 32 else { showToast("32 saved searches; remove one in settings"); return }
    savedSearches.append(SavedSearch(id:UUID(),query:query,index:scope.rawValue))
    SavedSearch.persist(savedSearches); showToast("Search saved")
  }
  func openSearch(_ saved: SavedSearch) {
    guard let index = FEScope(rawValue:saved.index), availableScopes.contains(index) else { errorMessage = "Saved index is unavailable: \(saved.index)"; return }
    showOptions = false; scope = index; query = saved.query; onQueryChange(query)
  }
  func removeSearch(_ saved: SavedSearch) { savedSearches.removeAll { $0.id == saved.id }; SavedSearch.persist(savedSearches) }

  private func cacheSearchProperties(_ values:[SearchReply.FileProperty]) {
    for value in values {
      guard let size=value.size,let modified=value.mtime,let directory=value.dir,directory>=0 else {continue}
      if metaCache[value.path] == nil, metaCache.count>=1024, let oldest=metaCache.keys.first {metaCache.removeValue(forKey:oldest)}
      metaCache[value.path]=(Date(),[.size:NSNumber(value:size),.modificationDate:Date(timeIntervalSince1970:modified/1000),.type:directory==1 ? FileAttributeType.typeDirectory : FileAttributeType.typeRegular])
    }
  }

  private func indexedItems(_ reply: SearchReply) -> [FEItem] {
    let properties = Dictionary((reply.properties ?? []).map { ($0.path, $0) }, uniquingKeysWith: { _, latest in latest })
    return reply.paths.map { FEItem(path: $0, indexedSize: properties[$0]?.size, indexedMtime: properties[$0]?.mtime,indexedDirectory:properties[$0]?.dir.map{$0==1}) }
  }

  func setQueryOption(_ key:String,_ value:String?) {
    query=SearchQueryOptions.setting(key,value,in:query);onQueryChange(query)
  }

  func prepareLookup(properties:Bool = false) {
    guard !indexing else {return}
    indexing=true;errorMessage=nil
    let index=scope.rawValue
    enrichmentTask=Task {
      let deadline=Date().addingTimeInterval(300)
      var inspected=0,finished=false
      do {
        for _ in 0..<100 {
          let remaining=Int(deadline.timeIntervalSinceNow)
          if Task.isCancelled || remaining<1 {break}
          indexingStatus=properties ? "Caching file size and date · \(inspected) checked…" : "Preparing fast lookup from saved paths…"
          let out=try await runTool([properties ? "properties" : "prepare","--index",index,"--seconds",String(min(20,remaining)),"--max-files","10000","--json"])
          guard !Task.isCancelled else {break}
          let reply=try JSONSerialization.jsonObject(with:Data(out.utf8)) as? [String:Any]
          if properties {inspected += reply?["inspected"] as? Int ?? 0;finished = reply?["pending"] as? Int == 0}
          else {finished = reply?["ready"] as? Bool == true}
          if finished {break}
        }
        if !Task.isCancelled {showToast(finished ? "Search index ready" : "Progress saved; continue in settings")}
      } catch {if !Task.isCancelled {errorMessage=error.localizedDescription}}
      indexing=false;indexingStatus="Building index…"
      if errorMessage == nil {onQueryChange(query,force:true)}
    }
  }

  func combineLookups() {
    guard !indexing else {return}
    indexing=true;errorMessage=nil;indexingStatus="Combining saved indexes · no folder scan…"
    enrichmentTask=Task {
      do {
        _ = try await runTool(["combine","--name","everything","--replace","--seconds","300","--json"])
        guard !Task.isCancelled else {indexing=false;return}
        await loadIndexes();scope=FEScope(rawValue:"everything")!
        showToast("Combined search ready")
      }catch{if !Task.isCancelled {errorMessage=error.localizedDescription}}
      indexing=false;indexingStatus="Building index…";if errorMessage == nil {onQueryChange(query,force:true)}
    }
  }

  private func fetchSearch(_ query: String, index: String, offset: Int = 0, limit: Int = 1000, generation: Int? = nil,interactive:Bool=false,preview:Bool=false) async throws -> SearchReply {
    loadPins()
    let effectiveQuery=viewOptions.effectiveQuery(query,learning:display.habitRanking)
    ensureSearchService?()
    let retryDeadline=Date().addingTimeInterval(10)
    var failure: Error = Self.serviceStarting
    for _ in 1...40 {
      try Task.checkCancellation()
      let started=Date()
      do {
        for _ in 0..<10 {
          if FileManager.default.fileExists(atPath: SearchSocket.path + ".json") {break}
          try Task.checkCancellation()
          try await Task.sleep(nanoseconds:40_000_000)
        }
        guard FileManager.default.fileExists(atPath: SearchSocket.path + ".json") else {throw Self.serviceStarting}
        return try await SearchSocket.search(effectiveQuery,index:index,offset:offset,limit:limit,generation:generation,interactive:interactive,preview:preview)
      } catch {
        // A restarted service refuses or drops its first connections while it boots;
        // only fast failures wait for it, a real slow answer is reported as it is.
        guard Date()<retryDeadline,!Task.isCancelled,Date().timeIntervalSince(started)<3,
              Self.transientFailure(error) else {throw error}
        failure=error
      }
      try await Task.sleep(nanoseconds:250_000_000)
    }
    throw failure
  }
  static let serviceStarting=NSError(domain:"FindEverythingSocket",code:1,userInfo:[NSLocalizedDescriptionKey:"Search service is starting. Retry in a moment."])
  private static let transientFailures=["Search service is starting. Retry in a moment.","Search service is unavailable","Search service timed out","Search service read failed"]
  private static func transientFailure(_ error: Error) -> Bool {
    let ns=error as NSError
    return ns.domain=="FindEverythingSocket" && transientFailures.contains(ns.localizedDescription)
  }
  private func fetchForQuery(_ query:String,index:String,offset:Int,limit:Int,generation:Int,preview:Bool=false) async throws -> SearchReply {
    guard !Task.isCancelled,generation==searchGeneration else {throw CancellationError()}
    foregroundFetch?.cancel()
    let id=UUID(),request=Task {try await fetchSearch(query,index:index,offset:offset,limit:limit,generation:generation,interactive:true,preview:preview)}
    foregroundID=id;foregroundFetch=request
    defer {if foregroundID==id {foregroundFetch=nil}}
    return try await request.value
  }

  private func startRange() -> Range<Int> {0..<min(resultCount,40)}
  func requestResults(_ range: Range<Int>) {
    guard !range.isEmpty, resultCount > 0, displayedQuery==viewKey,!searching,!indexing,!resultIsProvisional,!deferredSelectionRefresh else {return}
    wantedResults=range
    guard resultTask == nil else {return}
    let generation=searchGeneration,q=query,index=scope.rawValue
    resultTask=Task {
      defer {if generation==searchGeneration {resultTask=nil}}
      do {
        try await Task.sleep(nanoseconds:60_000_000)
        var attempted=Set<Int>()
        while !Task.isCancelled,generation==searchGeneration {
          let offsets=VirtualResults<FEItem>.requests(visible:wantedResults,total:resultCount)
          guard let offset=offsets.first(where:{!resultCache.contains($0) && !attempted.contains($0)}) else {break}
          attempted.insert(offset)
          let reply=try await fetchSearch(q,index:index,offset:offset,limit:VirtualResults<FEItem>.pageSize,generation:generation)
          guard !Task.isCancelled,generation==searchGeneration else {return}
          if !acceptResultPage(reply,offset:offset) {break}
        }
      }catch {
        if !Task.isCancelled,generation==searchGeneration {liveNote="Results unavailable: \(error.localizedDescription)"}
      }
    }
  }

  private func acceptResultPage(_ reply:SearchReply,offset:Int) -> Bool {
    guard let snapshot=resultSnapshot,let incoming=reply.snapshotId else {
      liveNote="Results cannot be paged until a stable snapshot is available";return false
    }
    guard snapshot==incoming else {
      if selectedRows.count>1 {deferSelectionRefresh()}
      else {onQueryChange(query,preserveSelection:true,force:true)}
      return false
    }
    let found=indexedItems(reply)
    resultCache.budget=resultBudget
    let visible=Set([VirtualResults<FEItem>.offset(for:wantedResults.lowerBound),VirtualResults<FEItem>.offset(for:max(0,wantedResults.upperBound-1))])
    resultCache.insert(found,at:offset,cost:found.reduce(0){$0+$1.path.utf8.count*2+256},protecting:visible)
    guard resultCache.contains(offset) else {
      if visible.contains(offset) {liveNote="Visible result range exceeds RAM cache budget"}
      return false
    }
    if totalMatches != reply.coverage?.matched {totalMatches=reply.coverage?.matched}
    if offset < wantedResults.upperBound && offset+found.count > wantedResults.lowerBound {virtualRevision += 1}
    if selectedRows.count<=1,currentItem != nil {selectionDidChange?()}
    flushQuickAction()
    return !found.isEmpty
  }

  func jumpBoundary(last: Bool) {
    if last && resultIsProvisional {pendingEnd=true;focusResults();return}
    select(last ? resultCount-1 : 0,trigger:.keyboard)
  }

  func prepareContents(clear: Bool = false) {
    guard !indexing else { return }
    indexing = true; errorMessage = nil; indexProgress = nil
    indexingTarget = scope.label
    indexingStatus = clear ? "Clearing cached document text…" : "Indexing document contents · Stop keeps saved progress"
    let index = scope.rawValue
    enrichmentTask = Task {
      defer { finishIndexing() }
      do {
        var pending = 0
        for _ in 0..<(clear ? 1 : 10) {
          guard !Task.isCancelled else { return }
          let args = clear ? ["content", "clear", "--index", index, "--json"] : ["content", "index", "--index", index, "--max-files", "500", "--seconds", "30", "--json"]
          let out = try await runTool(args)
          guard !Task.isCancelled else { return }
          guard let reply = try JSONSerialization.jsonObject(with: Data(out.utf8)) as? [String: Any] else {
            throw NSError(domain: "fe", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid document-index response. Saved progress is preserved."])
          }
          pending = reply["pending"] as? Int ?? 0
          let indexed = reply["indexed"] as? Int ?? 0, skipped = reply["skipped"] as? Int ?? 0
          indexingStatus = "\(indexed) documents indexed · \(skipped) skipped · Stop keeps saved progress"
          if pending == 0 { break }
        }
        showToast(clear ? "Cached document text cleared; original files unchanged" : pending == 0 ? "Document index saved; check search coverage" : "Partial document index saved. Run again to continue.")
        onQueryChange(query, force: true)
      } catch { if !Task.isCancelled { errorMessage = error.localizedDescription } }
    }
  }

  func enrich(repair: Bool = false) {
    guard !indexing else { return }
    indexing = true; errorMessage = nil; indexingStatus = "Reading media metadata…"
    let index = scope.rawValue
    enrichmentTask = Task {
      let deadline = Date().addingTimeInterval(300)
      var processed = 0
      do {
        for _ in 0..<10 {
          let remaining = Int(deadline.timeIntervalSinceNow)
          if Task.isCancelled || remaining < 1 { break }
          let out = try await runTool([repair ? "repair-media" : "enrich", "--json", "--index", index, "--kind", "media", "--max-files", "10000", "--seconds", String(min(30, remaining))])
          guard !Task.isCancelled else { break }
          let reply = try JSONSerialization.jsonObject(with: Data(out.utf8)) as? [String: Any]
          let probed = reply?[repair ? "inspected" : "probed"] as? Int ?? 0
          let pending = reply?["pending"] as? Int ?? 0
          processed += probed
          indexingStatus = "\(processed) checked · \(pending) pending"
          if pending == 0 || probed == 0 { break }
        }
      } catch { if !Task.isCancelled { errorMessage = error.localizedDescription } }
      indexing = false
      indexingStatus = "Building index…"
      if errorMessage == nil { onQueryChange(query,force:true) }
    }
  }

  func stopIndexing() {
    enrichmentTask?.cancel()
    if let running=indexProc {running.terminate();DispatchQueue.global().asyncAfter(deadline:.now()+2){if running.isRunning {kill(running.processIdentifier,SIGKILL)}}}
  }

  func analyzeSounds(setup: Bool = false) {
    guard !indexing else { return }
    indexing = true; errorMessage = nil
    indexingStatus = setup ? "Installing local sound model (163 MB)…" : "Analyzing sounds · 5 minutes maximum…"
    let index = scope.rawValue, intent = query
    enrichmentTask = Task {
      do {
        if setup { _ = try await runTool(["semantic", "setup"]) }
        else {
          let deadline = Date().addingTimeInterval(300)
          var processed = 0
          for _ in 0..<10 {
            let remaining = Int(deadline.timeIntervalSinceNow)
            if Task.isCancelled || remaining < 1 { break }
            let out = try await runTool(["semantic", "index", "--index", index, "--query", intent, "--max-files", "10000", "--seconds", String(min(30, remaining)), "--json"])
            guard !Task.isCancelled else { break }
            let reply = try JSONSerialization.jsonObject(with: Data(out.utf8)) as? [String: Any]
            let analyzed = reply?["analyzed"] as? Int ?? 0, pending = reply?["pending"] as? Int ?? 0
            processed += analyzed
            indexingStatus = "\(processed) sounds analyzed · \(pending) pending · Stop keeps saved progress"
            if pending == 0 || analyzed == 0 { break }
          }
        }
      } catch { if !Task.isCancelled { errorMessage = error.localizedDescription } }
      indexing = false
      if errorMessage == nil { onQueryChange(query,force:true) }
    }
  }

  func rebuild(exhaustive:Bool=false) {
    guard !indexing else { return }
    let target=scope.rawValue
    indexing=true;errorMessage=nil;indexingTarget=scope.label;indexProgress=IndexingProgress()
    enrichmentTask=Task {
      do {
        _ = try await runTool(["index","--index",target,"--progress-json"] + (exhaustive ? ["--exhaustive"] : []))
        if !Task.isCancelled {await loadIndexes()}
      } catch {if !Task.isCancelled {errorMessage=error.localizedDescription}}
      finishIndexing()
      if errorMessage == nil && !Task.isCancelled {showToast("Search index ready");onQueryChange(query,force:true)}
    }
  }

  /// Runs bounded index and configuration commands and returns stdout.
  private func runTool(_ args: [String]) async throws -> String {
    #if FE_NATIVE_TESTS
    if let testRunTool {return try await testRunTool(args)}
    #endif
    guard let fe = fePath else { throw NSError(domain: "fe", code: 1, userInfo: [NSLocalizedDescriptionKey: "fe is missing. Complete tool setup first."]) }
    return try await withCheckedThrowingContinuation { cont in
      DispatchQueue.global().async {
        let p = Process()
        let pipe = Pipe()
        let errors = Pipe()
        let errorLock = NSLock()
        var errorData = Data()
        p.executableURL = URL(fileURLWithPath: fe)
        let lifetime=Pipe()
        p.arguments = args.contains("--progress-json") ? args+["--parent-bound"] : args
        // EOF cancels even a paused job if this native app crashes. The writer remains
        // owned by the Process object in this app; no polling or private PID lookup.
        if args.contains("--progress-json") {p.standardInput=lifetime}
        p.standardOutput = pipe
        p.standardError = errors
        #if FE_NATIVE_TESTS
        if let environment=self.testProcessEnvironment {p.environment=environment}
        #endif
        errors.fileHandleForReading.readabilityHandler = { handle in
          let data = handle.availableData
          errorLock.lock(); errorData.append(data.prefix(max(0, 4096 - errorData.count))); errorLock.unlock()
        }
        do { try p.run() } catch { errors.fileHandleForReading.readabilityHandler = nil; cont.resume(throwing: error); return }
        if ["index","enrich","repair-media","semantic","prepare","properties","combine","content"].contains(args.first ?? "") {
          Task { @MainActor in
            self.indexProc = p
            if self.enrichmentTask?.isCancelled == true { p.terminate() }
          }
        }
        let timeout = DispatchWorkItem {
          if p.isRunning {
            p.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
              if p.isRunning { kill(p.processIdentifier, SIGKILL) }
            }
          }
        }
        let streaming=args.contains("--progress-json")
        // The supervisor owns active-time budgets; a pause must not hit this wall timer.
        if !streaming {DispatchQueue.global().asyncAfter(deadline: .now() + (args.first == "learn" ? 4 : args.first == "combine" ? 320 : args.first == "semantic" && args.contains("setup") ? 190 : 130), execute: timeout)}
        var protocolError: Error?
        let data: Data
        if streaming {
          var decoder=IndexingProgressDecoder()
          while true {
            let chunk=pipe.fileHandleForReading.availableData
            if chunk.isEmpty {break}
            do {
              for event in try decoder.append(chunk) {Task { @MainActor in self.acceptIndexProgress(event,from:p)}}
            } catch {protocolError=error;if p.isRunning {p.terminate()};break}
          }
          data=Data()
        } else {data=pipe.fileHandleForReading.readDataToEndOfFile()}
        p.waitUntilExit()
        timeout.cancel()
        Task { @MainActor in
          if self.indexProc === p { self.indexProc = nil }
        }
        errors.fileHandleForReading.readabilityHandler = nil
        if let protocolError {cont.resume(throwing:protocolError)}
        else if p.terminationStatus != 0 {
          errorLock.lock(); let message = String(data: errorData, encoding: .utf8) ?? ""; errorLock.unlock()
          cont.resume(throwing: NSError(domain: "fe", code: Int(p.terminationStatus), userInfo: [NSLocalizedDescriptionKey: message.isEmpty ? "Index or search failed (\(p.terminationStatus)). Retry or check fe status." : message.trimmingCharacters(in: .whitespacesAndNewlines)]))
        } else { cont.resume(returning: String(data: data, encoding: .utf8) ?? "") }
      }
    }
  }

  // MARK: actions

  var currentItem: FEItem? {
    guard !selectionNeedsConfirmation,displayedQuery==viewKey else {return nil};return cachedResult(at:selected)
  }
  var canSearchWeb:Bool {
    !selectionNeedsConfirmation && !indexing && errorMessage == nil && inputHint == nil && displayedQuery==viewKey && ResultNavigation.shouldSearchWeb(count:resultCount,searching:searching,query:query)
  }

  var visibleItems: [FEItem] {
    items
  }

  func setLearningEnabled(_ enabled:Bool) {
    Task {defer {onQueryChange(query,force:true)};do {_ = try await runTool(["learn",enabled ? "enable" : "disable"])} catch {errorMessage=error.localizedDescription}}
  }
  func resetSearchLearning() {
    Task {do {_ = try await runTool(["learn","reset"]);onQueryChange(query,force:true)} catch {errorMessage=error.localizedDescription}}
  }
  private func actionFailure(_ text:String) {actionError=text;showToast(text)}

  /// Resolve the entire selection against one generation and snapshot before acting.
  private func withSelectedItems(_ action:@escaping ([FEItem])->Void) {
    actionError=nil
    let chosen=selectedRows,generation=searchGeneration,snapshot=resultSnapshot
    guard let rows=ResultSelection.batchRows(chosen,limit:1000),!rows.isEmpty else {
      actionFailure("Select at most 1,000 files at a time");return
    }
    guard !selectionNeedsConfirmation,displayedQuery==viewKey,!searching else {
      actionFailure("Wait for the current search or select files again");return
    }
    if resultIsProvisional && rows.contains(where:{cachedResult(at:$0)==nil}) {
      actionFailure("Wait for the current search to finish");return
    }
    let offsets=Set(rows.map{VirtualResults<FEItem>.offset(for:$0)})
    guard offsets.count<=100 else {actionFailure("Selection spans too many pages; narrow the selection");return}
    let currentQuery=query,index=scope.rawValue
    Task {
      do {
        let found=try await ResultSelection.resolve(rows,pageSize:VirtualResults<FEItem>.pageSize,
          cached:{self.cachedResult(at:$0)},fetch:{offset in
            guard snapshot != nil else {throw NSError(domain:"FindEverything",code:1,userInfo:[NSLocalizedDescriptionKey:"Wait for the result snapshot"])}
            let reply=try await self.fetchSearch(currentQuery,index:index,offset:offset,limit:VirtualResults<FEItem>.pageSize,generation:generation)
            guard reply.snapshotId==snapshot else {throw CancellationError()}
            return self.indexedItems(reply)
          },isCurrent:{generation==self.searchGeneration && chosen==self.selectedRows && snapshot==self.resultSnapshot})
        action(found)
      } catch is CancellationError {actionFailure("Results or selection changed; select files again")}
      catch {actionFailure("Could not load selection: \(error.localizedDescription)")}
    }
  }

  func open(_ p:String) {openItems([FEItem(path:p)])}
  func openSelection(with application:URL?=nil) {
    if application == nil && selectedRows.count<=1 {performSelected(.open);return}
    withSelectedItems {self.openItems($0,with:application)}
  }
  private func openItems(_ items:[FEItem],with explicit:URL?=nil) {
    actionError=nil
    guard !items.isEmpty else {return}
    let context=query,index=scope.rawValue
    // Preserve the system's normal behavior for individual files and apps.
    if items.count==1,explicit==nil,openingPreferences.application(forFileName:items[0].name)==nil {
      let path=items[0].path
      guard NSWorkspace.shared.open(items[0].url) else {actionFailure("The file could not be opened");return}
      recordQuery(context);recordOpen(path)
      if display.habitRanking && !context.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty {
        Task {do {_ = try await runTool(["learn","open",path,"--query",context,"--index",index])} catch {errorMessage=error.localizedDescription}}
      }
      hidePanel?();return
    }
    var groups:[URL:[FEItem]]=[:]
    for item in items {
      guard FileManager.default.fileExists(atPath:item.path) else {actionFailure("A selected file no longer exists: \(item.name)");return}
      let configured=openingPreferences.application(forFileName:item.name).map{URL(fileURLWithPath:$0)}
      guard let app=explicit ?? configured ?? NSWorkspace.shared.urlForApplication(toOpen:item.url),
        FileManager.default.fileExists(atPath:app.path) else {actionFailure("No available application for \(item.name); check Opening settings");return}
      groups[app,default:[]].append(item)
    }
    Task {
      var successes:[String]=[],failures:[String]=[]
      for (app,group) in groups {
        let error:Error? = await withCheckedContinuation {continuation in
          NSWorkspace.shared.open(group.map(\.url),withApplicationAt:app,configuration:NSWorkspace.OpenConfiguration()) {_,error in continuation.resume(returning:error)}
        }
        if let error {failures.append("\(app.lastPathComponent): \(error.localizedDescription)")}
        else {successes.append(contentsOf:group.map(\.path))}
      }
      if !successes.isEmpty {
        recordQuery(context);recordOpened(successes)
        // Keep single-file learning without starting hundreds of processes for a batch.
        if successes.count==1,display.habitRanking,!context.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty {
          let path=successes[0]
          Task {do {_ = try await runTool(["learn","open",path,"--query",context,"--index",index])} catch {errorMessage=error.localizedDescription}}
        }
      }
      if failures.isEmpty {hidePanel?()}
      else {actionFailure("Opened \(successes.count)/\(items.count). \(failures.joined(separator:"; "))")}
    }
  }
  func revealSelection() {
    if selectedRows.count<=1,let item=currentItem {reveal(item.path);return}
    withSelectedItems {NSWorkspace.shared.activateFileViewerSelecting($0.map(\.url))}
  }
  func openSelectionFolder() {
    if selectedRows.count<=1,let item=currentItem {openFolder(item.path);return}
    revealSelection()
  }
  func copySelectionPaths() {
    if selectedRows.count<=1,let item=currentItem {copyPath(item.path);return}
    withSelectedItems {self.copyPath($0.map(\.path).joined(separator:"\n"))}
  }
  func filterSelectionTypes() {
    withSelectedItems {items in
      let extensions=Set(items.compactMap{OpeningPreferences.normalizedExtension($0.url.pathExtension)}).sorted()
      guard !extensions.isEmpty else {self.actionFailure("Selected items have no file extensions");return}
      guard let filter=SearchQueryOptions.extensionFilter(extensions.joined(separator:";")) else {self.actionFailure("Select fewer different file types");return}
      self.query=ResultColumn.type.clearing(in:self.query)
      self.columnFilter = .type
      self.setQueryOption("ext",filter)
    }
  }
  func chooseApplicationForSelection() {
    let picker=NSOpenPanel();picker.title="Open with";picker.prompt="Open"
    picker.canChooseFiles=true;picker.canChooseDirectories=false;picker.allowedContentTypes=[.applicationBundle]
    picker.directoryURL=URL(fileURLWithPath:"/Applications",isDirectory:true)
    if picker.runModal() == .OK,let application=picker.url {openSelection(with:application)}
  }
  func openFolder(_ p: String) {
    var isDir: ObjCBool = false
    FileManager.default.fileExists(atPath: p, isDirectory: &isDir)
    let dir = isDir.boolValue ? p : (p as NSString).deletingLastPathComponent
    NSWorkspace.shared.open(URL(fileURLWithPath: dir))
    hidePanel?()
  }
  func searchInFolder(_ p:String) {
    guard !p.isEmpty else {return}
    let indexed=items.first(where:{$0.path==p})?.indexedDirectory
    var isDirectory:ObjCBool=false
    if indexed == nil {FileManager.default.fileExists(atPath:p,isDirectory:&isDirectory)}
    let folder=(indexed ?? isDirectory.boolValue) ? p : (p as NSString).deletingLastPathComponent
    query=SearchQueryOptions.restricting(query,to:folder)
    columnFilter = .path;showActions=false
    onQueryChange(query);focusSearch()
  }
  func reveal(_ p: String) {
    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)])
    hidePanel?()
  }
  /// No-results fallback: ↵ with a dead query opens a web search instead
  /// of being a dead end (Raycast fallback-command pattern).
  func searchWeb(_ q: String) {
    #if FE_NATIVE_TESTS
    if let testWebAction {testWebAction(q);return}
    #endif
    let e = q.addingPercentEncoding(
      withAllowedCharacters: .urlQueryAllowed) ?? q
    if let u = URL(string: "https://duckduckgo.com/?q=\(e)") {
      NSWorkspace.shared.open(u)
    }
    hidePanel?()
  }
  func quickLook(_ p: String) {
    showQuickPreview?(p)
  }
  func trash(_ p: String) {
    #if FE_NATIVE_TESTS
    if let testTrashAction {testTrashAction(p);return}
    #endif
    var d = opens
    d.removeValue(forKey: p)
    saveOpens(d)
    try? FileManager.default.trashItem(
      at: URL(fileURLWithPath: p), resultingItemURL: nil)
    recents.removeAll { $0.path == p }
    onQueryChange(query,preserveSelection:true)
    showToast("Moved to Trash")
  }
  func duplicate(_ p: String) {
    let ns = p as NSString
    let dir = ns.deletingLastPathComponent
    let ext = ns.pathExtension
    let stem = (ns.lastPathComponent as NSString).deletingPathExtension
    var n = 1, dst = ""
    repeat {
      let suffix = n == 1 ? " copy" : " copy \(n)"
      dst = "\(dir)/\(stem)\(suffix)\(ext.isEmpty ? "" : ".\(ext)")"
      n += 1
    } while FileManager.default.fileExists(atPath: dst) && n < 100
    do {
      try FileManager.default.copyItem(atPath: p, toPath: dst)
      showToast("Duplicated")
    } catch { showToast("Duplicate failed") }
  }
  func compress(_ p: String) {
    let dst = p + ".zip"
    guard !FileManager.default.fileExists(atPath: dst)
    else { showToast("Archive exists already"); return }
    let pr = Process()
    pr.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
    pr.arguments = ["-c", "-k", "--sequesterRsrc", "--keepParent", p, dst]
    pr.terminationHandler = { [weak self] _ in
      Task { @MainActor in self?.showToast("Compressed") }
    }
    try? pr.run()
    showToast("Compressing…")
  }
  func copyContents(_ p: String) {
    let ext = (p as NSString).pathExtension.lowercased()
    guard DetailView.textExts.contains(ext),
          let s = try? String(contentsOfFile: p, encoding: .utf8)
    else { showToast("No text content"); return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(s, forType: .string)
    showToast("Contents copied")
  }
  func getInfo(_ p: String) {
    let safe = p.replacingOccurrences(of: "\"", with: "\\\"")
    let pr = Process()
    pr.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    pr.arguments = [
      "-e",
      "tell application \"Finder\" to open information window of (POSIX file \"\(safe)\" as alias)",
      "-e", "tell application \"Finder\" to activate",
    ]
    try? pr.run()
  }
  func share(_ p: String) {
    let picker = NSSharingServicePicker(items: [URL(fileURLWithPath: p)])
    if let v = AppDelegate.shared?.panel?.contentView {
      picker.show(
        relativeTo: NSRect(x: v.bounds.midX, y: 8, width: 1, height: 1),
        of: v, preferredEdge: .minY)
    }
  }
  func copyPath(_ p: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(p, forType: .string)
    showToast("Path copied")
  }
  func copyName(_ p: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(
      (p as NSString).lastPathComponent, forType: .string)
    showToast("Name copied")
  }
  func copyFile(_ p: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setData(
      nil, forType: .fileContents)
    NSPasteboard.general.writeObjects([NSURL(fileURLWithPath: p)])
    showToast("File copied")
  }
  func openTerminal(_ p: String) {
    var isDir: ObjCBool = false
    FileManager.default.fileExists(atPath: p, isDirectory: &isDir)
    let dir = isDir.boolValue ? p : (p as NSString).deletingLastPathComponent
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    proc.arguments = ["-a", "Terminal", dir]
    try? proc.run()
    hidePanel?()
  }

  // ⌘K action panel — the Raycast habit. Typing filters, →/↵ enters
  // submenus (Open With, Switch Scope), ←/Esc steps back one level.
  enum ActMenu { case root, openWith, scopes }
  struct ActItem {
    let title: String; let hint: String
    let run: (Model, String) -> Void
  }

  func showActionsPanel() {
    actMenu = .root; actSel = 0; actFilter = ""
    showActions = true; showHelp = false
  }
  func showHelpPanel() { showHelp = true; showActions = false }

  var actItems: [ActItem] {
    switch actMenu {
    case .openWith:
      return openWithApps.map { app in
        ActItem(title: app.deletingPathExtension().lastPathComponent,
                hint: "↵") { m, _ in
          m.actMenu = .root;m.openSelection(with:app)
        }
      }.filtered(actFilter)
    case .scopes:
      return availableScopes.map { s in
        ActItem(
          title: s.label,
          hint: FEScope.allCases.firstIndex(of: s).map { "⌘\($0 + 1)" } ?? ""
        ) { m, _ in m.scope = s }
      }.filtered(actFilter)
    case .root: break
    }
    let curPath = currentItem?.path ?? ""
    let isPinned = pinnedSet.contains(curPath)
    let list: [ActItem] = [
      ActItem(title: "Open", hint: "↵") { m, _ in m.openSelection() },
      ActItem(title: "Open Containing Folder", hint: "⌘↵") { m, _ in m.openSelectionFolder() },
      ActItem(title: "Search in This Folder", hint: "⌘⌥F") {m,_ in m.performSelected(.folder)},
      ActItem(title: "Reveal in Finder", hint: "⌘O") { m, _ in m.revealSelection() },
      ActItem(title: "Open With…", hint: "→") { m, _ in m.pushOpenWith() },
      ActItem(title: "Open in Terminal", hint: "⌘T") { m, p in m.openTerminal(p) },
      ActItem(title: "Quick Look Preview", hint: "Space / ⌘Y") { m, _ in m.performSelected(.preview) },
      ActItem(title: "Focus Search", hint: "⌘F") {m,_ in m.focusSearch(selectAll:true)},
      ActItem(title:isPinned ? "Remove from favorites" : "Add to favorites",hint:"⌘P") {m,p in m.togglePin(p)},
      ActItem(title: "Copy Path", hint: "⌘C") { m, _ in m.copySelectionPaths() },
      ActItem(title: "Copy Name", hint: "⌘⇧C") { m, p in m.copyName(p) },
      ActItem(title: "Copy File", hint: "⌘⌥C") { m, p in m.copyFile(p) },
      ActItem(title: "Copy Contents", hint: "⌘⌥⇧C") { m, p in m.copyContents(p) },
      ActItem(title: "Duplicate", hint: "") { m, p in m.duplicate(p) },
      ActItem(title: "Compress", hint: "") { m, p in m.compress(p) },
      ActItem(title: "Share…", hint: "") { m, p in m.share(p) },
      ActItem(title: "Get Info", hint: "⌘I") { m, p in m.getInfo(p) },
      ActItem(title: "Switch Scope", hint: "→") { m, _ in
        m.actMenu = .scopes; m.actSel = 0; m.actFilter = ""
      },
      ActItem(title: "Toggle Details", hint: "⌘D") { m, _ in m.showDetail.toggle() },
      ActItem(title: "Switch Window / Popup", hint: "⌘⇧W") { m, _ in m.toggleWindowMode?() },
      ActItem(title: "Index Media Properties", hint: "") { m, _ in m.enrich() },
      ActItem(title: "Copy Performance Diagnostics", hint: "") { m, _ in
        let payload: [String: Any] = ["events": m.interactionEvents, "lastSearchMs": m.lastMs,
          "mode": m.windowMode ? "window" : "popup", "resultCount": m.items.count]
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) {
          NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
          m.showToast("Diagnostics copied")
        }
      },
      ActItem(title: "Rebuild Index", hint: "⌘R") { m, _ in m.rebuild() },
      ActItem(title: "Index Folder or Project…", hint: "") { m, _ in m.indexFolder() },
      ActItem(title: "Reload Saved Indexes", hint: "") { m, _ in Task { await m.loadIndexes() } },
      ActItem(title: "Keyboard Shortcuts", hint: "⌘/") { m, _ in m.showHelp = true },
      ActItem(title: "Move to Trash", hint: "⌘⌫") { m, p in m.trash(p) },
      ActItem(title: "Quit Find Everything", hint: "⌘Q") { _, _ in NSApp.terminate(nil) },
    ]
    return list.filtered(actFilter)
  }

  func pushOpenWith() {
    guard let p = currentItem?.path else { return }
    openWithApps = NSWorkspace.shared
      .urlsForApplications(toOpen: URL(fileURLWithPath: p))
    actMenu = .openWith; actSel = 0; actFilter = ""
  }

  func runAction(_ i: Int) {
    guard let a = actItems[safe: i] else { return }
    let global = ["Focus Search", "Switch Scope", "Toggle Details", "Switch Window / Popup", "Index Media Properties", "Copy Performance Diagnostics", "Rebuild Index", "Index Folder or Project…", "Reload Saved Indexes", "Keyboard Shortcuts", "Quit Find Everything"]
    guard currentItem != nil || actMenu == .scopes || global.contains(a.title) else { return }
    a.run(self, currentItem?.path ?? "")
    // A submenu push keeps the panel open; everything else closes it.
    if actMenu != .root { actSel = 0; actFilter = "" }
    else { showActions = false; actFilter = "" }
  }

  func cycleScope(_ direction: Int) {
    let all = availableScopes
    let current = all.firstIndex(of: scope) ?? 0
    scope = all[(current + direction + all.count) % all.count]
  }
}

#if FE_NATIVE_TESTS
extension Model {
  func testSeed(paths:[String],query:String,snapshot:String?,selection:IndexSet,lead:Int,total:Int,provisional:Bool=false) {
    searchTask?.cancel();resultTask?.cancel()
    self.query=query;displayedQuery=viewKey;searching=false;indexing=false;inputHint=nil
    items=paths.map{FEItem(path:$0)};resultCache.removeAll()
    resultCache.insert(items,at:0,cost:items.reduce(0){$0+$1.path.utf8.count*2+256})
    totalMatches=total;resultSnapshot=snapshot;resultIsProvisional=provisional
    selectionNeedsConfirmation=false;deferredSelectionRefresh=false;selectionWasExplicit=true
    selectedRows=selection;selected=lead;selectionAnchor=lead;wantedResults=0..<min(total,items.count)
    searchGeneration=1;actionError=nil
  }
  var testRefreshDeferred:Bool {deferredSelectionRefresh}
  var testSnapshot:String? {resultSnapshot}
  func testAcceptPage(_ reply:SearchReply,offset:Int) -> Bool {acceptResultPage(reply,offset:offset)}
  func testPublishExactPreview(_ reply:SearchReply) -> Bool {publishExactPreservingSelection(reply,query:query,start:0)}
  func testPublishRefresh(_ reply:SearchReply,initialSelection:IndexSet,initialLead:Int) -> Bool {
    publishFinalReply(reply,query:query,start:0,publishedPreview:false,preserveSelection:true,initialSelection:initialSelection,initialLead:initialLead).published
  }
  var testPendingQuickAction:Bool {pendingQuickAction != nil}
  func testCancelSearch() {searchGeneration += 1;searchTask?.cancel();searchTask=nil}
}
#endif

extension Array where Element == Model.ActItem {
  func filtered(_ f: String) -> [Model.ActItem] {
    f.isEmpty ? self
      : filter { $0.title.localizedCaseInsensitiveContains(f) }
  }
}

// MARK: - Views

func relTime(_ d: Date?) -> String {
  guard let d else { return "" }
  let s = -d.timeIntervalSinceNow
  if s < 90 { return "now" }
  if s < 3600 { return "\(Int(s / 60))m" }
  if s < 86400 { return "\(Int(s / 3600))h" }
  if s < 86400 * 7 { return "\(Int(s / 86400))d" }
  if s < 86400 * 30 { return "\(Int(s / 604800))w" }
  if s < 86400 * 365 { return "\(Int(s / 2592000))mo" }
  return "\(Int(s / 31536000))y"
}

struct RowView: View {
  @EnvironmentObject var m: Model
  @Environment(\.colorScheme) var scheme
  let item: FEItem
  let selected: Bool
  let meta: [FileAttributeKey: Any]?
  var pinned = false
  var stripe = false
  var palette: SearchPalette { .forScheme(scheme) }
  var label: Color { selected ? .white : palette.text }
  var secondary: Color { selected ? .white : palette.muted }
  var directory: Bool { item.indexedDirectory ?? ((meta?[.type] as? FileAttributeType) == .typeDirectory) }
  var fullDirectory: String { (item.path as NSString).deletingLastPathComponent.replacingOccurrences(of:NSHomeDirectory(),with:"~") }
  var sizeValue: Double? {
    let sort = SearchQueryOptions.value("sort",in:m.query)
    if sort == "big" || sort == "small" { return item.indexedSize }
    return item.indexedSize ?? (meta?[.size] as? NSNumber)?.doubleValue
  }
  var modifiedValue: Date? {
    let cached = item.indexedMtime.map { Date(timeIntervalSince1970:$0/1000) }
    let sort = SearchQueryOptions.value("sort",in:m.query)
    if sort == "new" || sort == "old" { return cached }
    return cached ?? meta?[.modificationDate] as? Date
  }
  var body: some View {
    HStack(spacing: 10) {
      if m.display.showIcons {
        Image(nsImage:ResultIcons.icon(for:item.path)).resizable()
          .frame(width:m.display.compact ? 16 : 24,height:m.display.compact ? 16 : 24)
      }
      VStack(alignment:.leading,spacing:3) {
        HStack(spacing:4) {
          if pinned {Image(systemName:"star.fill").font(.system(size:10)).foregroundStyle(secondary).accessibilityLabel("Favorite")}
          Text(item.name).font(.system(size:m.display.fontSize,weight:selected ? .semibold : .regular)).lineLimit(1).truncationMode(.middle)
        }.foregroundStyle(label)
        if !m.display.compact && m.display.showPath { Text(fullDirectory).font(.system(size:m.display.fontSize-1)).foregroundStyle(secondary).lineLimit(1).truncationMode(.middle) }
      }.frame(minWidth:96,maxWidth:.infinity,alignment:.leading)
      if m.display.compact && m.display.showPath { Text(fullDirectory).font(.system(size:m.display.fontSize-1)).foregroundStyle(secondary).lineLimit(1).truncationMode(.middle).frame(minWidth:100,maxWidth:.infinity,alignment:.leading) }
      if m.display.showType { Text(directory ? "Folder" : (item.path as NSString).pathExtension.uppercased()).lineLimit(1).frame(width:48,alignment:.leading) }
      if m.display.showSize { Text(directory ? "—" : sizeValue.map(humanSize) ?? "—").monospacedDigit().frame(width:68,alignment:.trailing) }
      if m.display.showModified { Text(modifiedValue.map {relTime($0)} ?? "—").monospacedDigit().frame(width:72,alignment:.trailing) }
    }
    .font(.system(size:m.display.fontSize-1)).foregroundStyle(secondary)
    .padding(.horizontal,14).padding(.vertical,m.display.compact ? 5 : 8)
    .frame(minHeight:m.display.compact ? 28 : 44)
    .background(selected ? palette.selection : stripe && m.display.stripedRows ? palette.surface : palette.paper)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .contentShape(Rectangle())
  }
}

struct ResultColumnsView: View {
  @EnvironmentObject var m: Model
  @Environment(\.colorScheme) var scheme
  private var palette:SearchPalette {.forScheme(scheme)}
  private func heading(_ column:ResultColumn) -> some View {
    let filtered = !column.filters(in:m.query).isEmpty
    let direction=column.direction(in:m.query)
    return HStack(spacing:4) {
      Button {
        if let sort=column.nextSort(in:m.query) {m.setQueryOption("sort",sort)}
        else {m.columnFilter=m.columnFilter == column ? nil : column}
      } label: {
      HStack(spacing:3) {
        Text(column.title).lineLimit(1)
        Image(systemName:direction ?? (column == .type ? "chevron.down" : "arrow.up.arrow.down")).font(.system(size:8,weight:.bold)).frame(width:9)
        Circle().fill(filtered ? palette.selection : Color.clear).frame(width:4,height:4)
      }.foregroundStyle(filtered || direction != nil ? palette.text : palette.muted).contentShape(Rectangle())
      }.buttonStyle(.plain).accessibilityLabel(column == .type ? "Type filter" : "Sort by \(column.title)")
        .help(column == .type ? "Open type filters" : "Sort by \(column.title) · click again to reverse")
    }
  }
  var body: some View {
    VStack(spacing:0) {
      HStack(spacing:10) {
        Button {m.columnFilter=m.columnFilter == nil ? .name : nil} label:{Image(systemName:"line.3.horizontal.decrease.circle")}
          .buttonStyle(.plain).frame(width:m.display.compact ? 16 : 24).accessibilityLabel(m.columnFilter == nil ? "Expand filter bar" : "Collapse filter bar")
        heading(.name).frame(minWidth:96,maxWidth:.infinity,alignment:.leading)
        if m.display.compact && m.display.showPath {heading(.path).frame(minWidth:100,maxWidth:.infinity,alignment:.leading)}
        if m.display.showType {heading(.type).frame(width:48,alignment:.leading)}
        if m.display.showSize {heading(.size).frame(width:68,alignment:.trailing)}
        if m.display.showModified {heading(.modified).frame(width:72,alignment:.trailing)}
      }.font(.system(size:11,weight:.semibold)).padding(.horizontal,14).padding(.vertical,8)
      let active=ResultColumn.allCases.filter{!$0.filters(in:m.query).isEmpty}
      if !active.isEmpty || SearchQueryOptions.value("favorites",in:m.query)=="true" {
        HStack(spacing:8) {
          ScrollView(.horizontal,showsIndicators:false) {
            HStack(spacing:6) {
              if SearchQueryOptions.value("favorites",in:m.query)=="true" {
                Button {m.setQueryOption("favorites",nil)} label:{Label("Favorites ×",systemImage:"star.fill").padding(.horizontal,7).padding(.vertical,4).background(palette.paper).cornerRadius(4)}.buttonStyle(.plain).accessibilityLabel("Clear favorites filter")
              }
              ForEach(active) {column in
                Button {m.query=column.clearing(in:m.query);m.onQueryChange(m.query)} label: {
                  HStack(spacing:4) {Text(column.title+": "+column.summary(in:m.query)).lineLimit(1);Image(systemName:"xmark").font(.system(size:8,weight:.bold))}
                    .padding(.horizontal,7).padding(.vertical,4).background(palette.paper).cornerRadius(4)
                }.buttonStyle(.plain).accessibilityLabel("Clear \(column.title) filter")
              }
            }
          }
          Button("Clear filters") {m.query=SearchQueryOptions.setting("favorites",nil,in:ResultColumn.allCases.reduce(m.query){$1.clearing(in:$0)});m.onQueryChange(m.query)}.buttonStyle(.borderless)
        }.font(.system(size:11)).padding(.horizontal,14).padding(.bottom,6)
      }
    }.foregroundStyle(palette.text).background(palette.surface)
  }
}

func humanSize(_ v: Double) -> String {
  let u = ["B", "KB", "MB", "GB"]; var x = v, i = 0
  while x >= 1024 && i < u.count - 1 { x /= 1024; i += 1 }
  return i == 0 ? "\(Int(x)) \(u[i])" : String(format: "%.1f %@", x, u[i])
}

struct DetailView: View {
  let item: FEItem
  @State private var attrs: [FileAttributeKey: Any] = [:]
  @State private var preview: String? = nil
  static let textExts: Set<String> = [
    "md","txt","swift","ts","tsx","js","jsx","json","py","sh","zsh","bash",
    "yml","yaml","xml","csv","log","conf","cfg","ini","toml","html","css",
    "rb","go","rs","c","h","cpp","java","sql","env","plist","gitignore",
    "editorconfig","lock","diff","patch","tex","rtf",
  ]
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let img = NSImage(contentsOfFile: item.path),
         ["png","jpg","jpeg","gif","webp","heic","tiff","bmp","svg","ico"]
           .contains((item.path as NSString).pathExtension.lowercased()) {
        Image(nsImage: img).resizable().scaledToFit()
          .frame(maxHeight: 160).cornerRadius(6)
      } else {
        Image(nsImage: NSWorkspace.shared.icon(forFile: item.path))
          .resizable().frame(width: 48, height: 48)
      }
      Text(item.name).font(.headline).lineLimit(2)
      Group {
        Labeled("Path", value: item.path)
        Labeled("Size", value: sizeText)
        Labeled("Modified", value: mtimeText)
      }
      .font(.system(size: 11))
      if let preview {
        ScrollView {
          Text(preview)
            .font(.system(size: 9, design: .monospaced))
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(6).background(.quaternary.opacity(0.5)).cornerRadius(6)
      }
      Spacer()
    }
    .padding(14).frame(maxWidth: .infinity, alignment: .leading)
    .onAppear { stat() }
    .onChange(of: item) { _ in stat() }
  }
  func stat() {
    attrs = (try? FileManager.default
      .attributesOfItem(atPath: item.path)) ?? [:]
    preview = loadPreview()
  }
  func loadPreview() -> String? {
    let ext = (item.path as NSString).pathExtension.lowercased()
    guard DetailView.textExts.contains(ext),
          let data = try? Data(contentsOf: URL(fileURLWithPath: item.path),
                               options: .mappedIfSafe),
          data.count < 4_000_000,
          let s = String(data: data.prefix(100_000), encoding: .utf8)
    else { return nil }
    return String(s.prefix(6_000))
  }
  var sizeText: String {
    if let n = attrs[.size] as? NSNumber {
      let u = ["B","KB","MB","GB"]; var v = n.doubleValue; var i = 0
      while v >= 1024 && i < u.count-1 { v /= 1024; i += 1 }
      return String(format: i == 0 ? "%.0f %@" : "%.1f %@", v, u[i])
    }
    return "—"
  }
  var mtimeText: String {
    (attrs[.modificationDate] as? Date)?.description ?? "—"
  }
}

struct Labeled: View {
  let title: String; let value: String
  init(_ t: String, value: String) { title = t; self.value = value }
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title.uppercased()).font(.system(size: 9, weight: .semibold))
        .foregroundStyle(.tertiary)
      Text(value).textSelection(.enabled).lineLimit(3)
        .foregroundStyle(.secondary)
    }
  }
}

struct SetupView: View {
  @EnvironmentObject var m: Model
  var body: some View {
    VStack(spacing: 16) {
      Image(nsImage: NSApp.applicationIconImage).frame(width: 48, height: 48)
      Text("Find Everything").font(.title2.weight(.semibold))
      Text("Install fd, ripgrep and fzf with a package manager you trust.\nThis preview does not download or run missing tools for you.")
        .multilineTextAlignment(.center).foregroundStyle(.secondary)
        .font(.system(size: 12))
      Text(m.setupLog).font(.system(size: 11, design: .monospaced))
        .foregroundStyle(.secondary).lineLimit(3)
      Text("brew install fd ripgrep fzf").font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
      Link("Read setup instructions", destination: URL(string: "https://github.com/Supersynergy/find-everything#build-from-source")!)
      Button("Check tools again") { m.bootstrap() }
        .keyboardShortcut(.defaultAction)
    }
    .padding(28).frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

struct SearchView: View {
  @EnvironmentObject var m: Model
  @Environment(\.colorScheme) var scheme
  var palette: SearchPalette { .forScheme(scheme) }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Image(systemName: "magnifyingglass").foregroundStyle(palette.muted)
        SearchInput(color:palette.text).frame(height:19)
          .accessibilityLabel("Search files and folders")
          .padding(.trailing, m.query.isEmpty ? 0 : 14)
          .overlay(alignment:.leading) {
            if m.query.isEmpty { Text("Search files and folders…").font(.system(size:15)).foregroundStyle(palette.muted).allowsHitTesting(false).accessibilityHidden(true) }
          }
          // Cancel button like NSSearchField: one click clears, Esc and ⌘Z
          // stay equivalent.
          .overlay(alignment:.trailing) {
            if !m.query.isEmpty {
              Button {m.clearQuery()} label: {
                Image(systemName:"xmark.circle.fill")
                  .font(.system(size:12,weight:.semibold))
                  .foregroundStyle(palette.muted)
                  .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .help("Clear search · Esc · ⌘⌫")
              .accessibilityLabel("Clear search")
            }
          }
          .padding(7).background(palette.paper).cornerRadius(5)
          .overlay(RoundedRectangle(cornerRadius:5).stroke(m.inputFocus == .search ? palette.selection : palette.border,lineWidth:1))
          .onChange(of: m.query) { m.onQueryChange($0) }
          .onAppear { m.focusSearch() }
          .onReceive(
            NotificationCenter.default.publisher(
              for: NSWindow.didBecomeKeyNotification)
          ) { note in
            guard let window=note.object as? NSWindow,window === AppDelegate.shared?.panel,
              !m.showOptions,m.columnFilter == nil else {return}
            if m.resultFocused {m.focusResults()} else {m.focusSearch()}
          }
        Picker("", selection: $m.scope) {
          ForEach(m.availableScopes) {
            Text($0.label).tag($0)
          }
        }
        .labelsHidden().frame(width: 110).accessibilityLabel("Search scope")
        .help("⌘1–⌘6 or ⌘K → Switch Scope")
        .onChange(of: m.scope) { s in
          UserDefaults.standard.set(s.rawValue, forKey: "scope")
          if s == .custom { m.indexFolder() }
          else { m.onQueryChange(m.query) }
        }
        Menu {
          Button("Save current search") { m.saveSearch() }.keyboardShortcut("d",modifiers:[.command,.shift])
          if !m.savedSearches.isEmpty { Divider() }
          ForEach(m.savedSearches) { saved in Button(saved.title) { m.openSearch(saved) } }
        } label: { Image(systemName:"bookmark") }
          .menuStyle(.borderlessButton).fixedSize().accessibilityLabel("Saved searches")
        Button {m.showSortBar.toggle()} label:{Image(systemName:"arrow.up.arrow.down")}.buttonStyle(.borderless)
          .accessibilityLabel(m.showSortBar ? "Collapse sort bar" : "Expand sort bar").help("Sort options · ⌘⇧S")
        Button {m.columnFilter=m.columnFilter == .type ? nil : .type} label:{Image(systemName:"line.3.horizontal.decrease.circle")}.buttonStyle(.borderless)
          .accessibilityLabel("Filter file types").help("Filter one or several file extensions")
        Button {m.setQueryOption("favorites",SearchQueryOptions.value("favorites",in:m.query)=="true" ? nil : "true")} label:{Image(systemName:SearchQueryOptions.value("favorites",in:m.query)=="true" ? "star.fill" : "star")}.buttonStyle(.borderless).accessibilityLabel("Filter favorites").help("Favorites only · combine with other filters")
        Button { m.indexFolder() } label: { Image(systemName: "folder.badge.plus") }
          .buttonStyle(.borderless)
          .accessibilityLabel("Index folder or project")
          .help("Add a folder or project index")
          .disabled(m.indexing)
        Button { m.toggleWindowMode?() } label: { Image(systemName: m.windowMode ? "rectangle.compress.vertical" : "macwindow") }
          .buttonStyle(.borderless)
          .accessibilityLabel(m.windowMode ? "Switch to popup mode" : "Switch to window mode")
          .help("Switch window / popup · ⌘⇧W")
        Button { m.showOptions.toggle() } label: { Image(systemName: "gearshape") }
          .buttonStyle(.borderless).accessibilityLabel("Search options")
          .help("Options · ⌘,")
          .popover(isPresented: $m.showOptions, arrowEdge: .bottom) { SearchOptionsView().environmentObject(m) }
      }
      .foregroundStyle(palette.text).padding(.horizontal,14).padding(.vertical,9).background(palette.surface)
      Divider()
      ResultColumnsView()
      ResultSortBar()
      ResultFiltersView()
      if let error = m.actionError ?? m.errorMessage ?? m.shortcutWarning {
        HStack {
          Text(error).font(.system(size: 11)).foregroundStyle(.red).lineLimit(3)
          Spacer()
          if m.actionError != nil {
            if m.selectionRefreshPaused {Button("Refresh") {m.refreshDeferredResults()}}
            Button("Dismiss") {m.actionError=nil}
          }
          else if error.contains("semantic setup") {
            Button("Set up sound search") { m.analyzeSounds(setup: true) }.disabled(m.indexing)
          } else if m.needsIndex {
            Button("Index \(m.scope.label)") { m.rebuild() }.disabled(m.indexing)
            Button("Index Folder…") { m.indexFolder() }.disabled(m.indexing)
          } else if m.errorMessage != nil { Button("Retry") { m.onQueryChange(m.query) }.disabled(m.indexing) }
        }.padding(10)
      }
      Group {
        if m.indexing && m.indexProgress == nil {
          VStack(spacing: 8) {
            ProgressView().scaleEffect(0.8)
            Text(m.indexingStatus).font(.system(size: 12))
              .foregroundStyle(.secondary)
            Button("Stop") { m.stopIndexing() }
          }.frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if m.items.isEmpty {
          VStack(spacing: 6) {
            Text(m.indexing ? "Your files will appear when the index is ready" : m.searching ? "Searching…" : m.needsIndex ? "No saved index for this scope" : m.unknownProperties>0 ? "No matches with known file properties" : "No matches")
              .font(.system(size: 12)).foregroundStyle(.secondary)
            if !m.indexing && !m.searching && m.errorMessage == nil && m.query.count > 1 {
              Text(m.unknownProperties>0 ? "Size/date are unknown for \(m.unknownProperties) matching paths. See Search details." : "Try a name, ext:pdf, or open search help.")
                .font(.system(size: 10)).foregroundStyle(.tertiary)
            }
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          HStack(spacing: 0) {
            VirtualResultTable {item,row in
              AnyView(VStack(spacing:0) {
                if m.hasResultGroups {
                  Text(m.headerBefore(row) ?? "").font(.system(size:9,weight:.semibold)).foregroundStyle(.secondary).frame(maxWidth:.infinity,alignment:.leading).padding(.horizontal,14).frame(height:20)
                }
                RowView(item:item,selected:m.selectedRows.contains(row),meta:(item.indexedSize == nil || item.indexedDirectory == nil) ? m.meta(for:item.path) : nil,
                              pinned:m.pinnedSet.contains(item.path),stripe:row % 2 == 1)
                .environmentObject(m)
              })
            }
            if m.showDetail, let it = m.currentItem {
              Divider()
              DetailView(item: it)
                .frame(width: 280)
            }
          }
        }
      }
      .frame(maxHeight: .infinity)
      Divider()
      HStack(spacing: 10) {
          Button { m.showOptions = true } label: { Image(systemName:"info.circle").frame(width:16,height:16) }
            .buttonStyle(.plain).help("Search details and index coverage").accessibilityLabel("Search details")
        if m.indexing {IndexingFooter(palette:palette)}
        else if let hint=m.inputHint {
          Text(hint).font(.system(size:10)).foregroundStyle(palette.muted).lineLimit(1)
        } else if !m.toast.isEmpty {
          Text(m.toast).font(.system(size: 10))
            .foregroundStyle(.secondary)
            .transition(.opacity)
        } else if m.viewOptions.keyboardHints {
          Text(m.resultFocused ? "Space Preview · ↵ Open · Tab Actions" : "↑↓ Results · ⌘F Search · ⌘K Actions")
            .font(.system(size:10)).foregroundStyle(palette.muted).lineLimit(1).frame(width:230,alignment:.leading)
        }
        if !m.indexing {
        Spacer()
        Text(!m.items.isEmpty
          ? m.showingStartupCache ? "\(m.totalMatches ?? m.items.count) cached paths" : "\(m.totalMatches ?? m.items.count)\(m.resultIsProvisional ? "+" : "") results · \(m.lastMs)ms"
          : m.scope.label)
          .font(.system(size: 11)).monospacedDigit().foregroundStyle(palette.muted)
        Button { m.showHelp = true } label: {
          Image(systemName: "questionmark.circle").accessibilityLabel("Search help")
            .font(.system(size: 13)).foregroundStyle(.secondary)
        }
        .buttonStyle(.plain).help("Keyboard shortcuts ⌘/")
        Button { m.showActionsPanel() } label: {
          Image(systemName: "ellipsis.circle")
            .font(.system(size: 13)).foregroundStyle(.secondary)
        }
        .buttonStyle(.plain).help("Actions ⌘K").accessibilityLabel("Actions")
        }
      }
      .foregroundStyle(palette.muted).padding(.horizontal,14).padding(.vertical,7).background(palette.surface)
    }
    .overlay(alignment: .trailing) {
      if m.showActions {
        ZStack(alignment:.trailing) {
          Color.black.opacity(0.001).contentShape(Rectangle()).onTapGesture {m.showActions=false}
          ActionPanelView().environmentObject(m)
        }
      }
    }
    .onChange(of:m.columnFilter) {value in if value == nil {if m.resultFocused {m.focusResults()} else {m.focusSearch()}}}
    .overlay(alignment: .center) {
      if m.showHelp {
        ZStack {
          Color.black.opacity(0.001).contentShape(Rectangle()).onTapGesture {m.showHelp=false}
          HelpView().environmentObject(m)
        }
      }
    }
  }
}

struct ActionPanelView: View {
  @EnvironmentObject var m: Model
  var menuTitle: String {
    switch m.actMenu {
    case .root: "ACTIONS"
    case .openWith: "← OPEN WITH"
    case .scopes: "← SCOPE"
    }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(m.actFilter.isEmpty
        ? menuTitle
        : "FILTER: \(m.actFilter.uppercased())")
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(.tertiary)
        .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 5)
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(spacing: 0) {
            ForEach(m.actItems.indices, id: \.self) { i in
              HStack {
                Text(m.actItems[i].title).font(.system(size: 12))
                Spacer()
                Keycaps(m.actItems[i].hint)
              }
              .padding(.horizontal, 12).padding(.vertical, 6)
              .background(
                i == m.actSel ? Color.accentColor.opacity(0.25) : .clear)
              .id(i)
              .contentShape(Rectangle())
              .onTapGesture { m.actSel = i; m.runAction(i) }
            }
          }
        }
        .onChange(of: m.actSel) { i in
          withAnimation(.none) { proxy.scrollTo(i, anchor: .center) }
        }
      }
      if m.actItems.isEmpty {
        Text("No matches").font(.system(size: 11))
          .foregroundStyle(.secondary).padding(12)
      }
    }
    .frame(width: 240).frame(maxHeight: 380)
    .background(.ultraThinMaterial)
    .cornerRadius(10)
    .overlay(RoundedRectangle(cornerRadius: 10)
      .stroke(.quaternary, lineWidth: 1))
    .padding(10)
  }
}

/// Raycast-style keycaps: each character of a hint like "⌘⇧C" becomes
/// its own little key. "→"/"↵" submenu and enter markers render the same.
struct Keycaps: View {
  let hint: String
  init(_ h: String) { hint = h }
  var body: some View {
    HStack(spacing: 3) {
      ForEach(Array(hint.enumerated()), id: \.offset) { _, ch in
        Text(String(ch))
          .font(.system(size: 10, weight: .medium, design: .rounded))
          .foregroundStyle(.secondary)
          .padding(.horizontal, 5).padding(.vertical, 2)
          .background(Color.primary.opacity(0.09))
          .cornerRadius(4)
          .overlay(
            RoundedRectangle(cornerRadius: 4)
              .stroke(Color.primary.opacity(0.14), lineWidth: 0.5)
              .padding(0.5)
          )
      }
    }
  }
}

struct SectionLabel: View {
  let title: String
  init(_ t: String) { title = t }
  var body: some View {
    Text(title.uppercased())
      .font(.system(size: 9, weight: .semibold))
      .foregroundStyle(.tertiary)
      .padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 4)
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// ⌘/ help card — every shortcut, grouped. Not cluttering the field.
struct HelpView: View {
  @EnvironmentObject var m: Model
  let groups: [(String, String)] = [
    ("Navigate", "↑ ↓ · ^N ^P · PgUp PgDn · ⌘↑ ⌘↓ · Home End"),
    ("History", "⌥↑ / ⌥↓ past queries · ⌘⌫ clear line · ⌘Z restore"),
    ("Path", "⇧Tab parent dir · ⌘L / ⌘F search field · ⌘A select all"),
    ("Open", "↵ open · ⌘↵ folder · ⌥↵ reveal · Space / ⌘Y preview"),
    ("Actions", "⌘K or Tab · type to filter · → submenu · ← back"),
    ("File", "⌘C path · ⌘⇧C name · ⌘⌥C file · ⌘⌥⇧C contents"),
    ("File 2", "⌘I info · ⌘P pin · ⌘⌫ trash"),
    ("Tools", "⌘T terminal · ⌘R rebuild index"),
    ("Scope", "⌘1–⌘6 · ⌘⌥← ⌘⌥→ cycle"),
    ("Query", "ext:md · *.pdf · type:image · !tmp · \"exact\" · a|b"),
    ("Query 2", "audio: duration:<1s · channels:1 · samplerate:>=44.1k"),
    ("Describe", "(kurze düstere Lasersounds) · local audio ranking"),
    ("Options", "⌘, · automatic updates · details · audio tools"),
    ("Panel", "⌘⇧W window / popup · ⌥Space toggle · ⌘W hide"),
  ]
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("KEYBOARD SHORTCUTS")
        .font(.system(size: 9, weight: .semibold))
        .foregroundStyle(.tertiary)
        .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 6)
      ForEach(groups.indices, id: \.self) { i in
        HStack {
          Text(groups[i].0)
            .font(.system(size: 11, weight: .medium))
            .frame(width: 70, alignment: .leading)
          Text(groups[i].1).font(.system(size: 11))
            .foregroundStyle(.secondary)
          Spacer()
        }
        .padding(.horizontal, 14).padding(.vertical, 4)
      }
      Text("any key closes")
        .font(.system(size: 9)).foregroundStyle(.tertiary)
        .padding(.horizontal, 14).padding(.vertical, 8)
    }
    .frame(width: 380)
    .background(.ultraThinMaterial)
    .cornerRadius(10)
    .overlay(RoundedRectangle(cornerRadius: 10)
      .stroke(.quaternary, lineWidth: 1))
  }
}

// MARK: - Panel & hotkey

final class KeyPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  static var shared: AppDelegate!
  let model = Model()
  var panel: KeyPanel!
  var hotkeyRef: EventHotKeyRef?
  var hotkeyHandler: EventHandlerRef?
  var statusItem: NSStatusItem?
  let quickPreview=QuickPreviewController()
  var hotkeyRegistration: OSStatus = noErr
  var hotkeyHandlerStatus: OSStatus = noErr
  var hotkeyEvents = 0
  var keyMonitor: Any?
  var serviceProcess: Process?
  var terminationSignal: DispatchSourceSignal?

  func applicationDidFinishLaunching(_ n: Notification) {
    AppDelegate.shared = self
    signal(SIGTERM, SIG_IGN)
    let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    termination.setEventHandler { NSApp.terminate(nil) }
    termination.resume(); terminationSignal = termination
    applyDockVisibility()
    installApplicationMenu()

    let p = KeyPanel(
      contentRect: NSRect(x: 0, y: 0, width: 640, height: 420),
      styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView],
      backing: .buffered, defer: false)
    p.titleVisibility = .hidden
    p.title = "Find Everything"
    p.isReleasedWhenClosed = false
    p.titlebarAppearsTransparent = true
    p.isMovableByWindowBackground = true
    p.isFloatingPanel = true
    p.level = .floating
    // FE_KEEP_VISIBLE=1 keeps the panel up for screenshots/UI tests.
    p.hidesOnDeactivate =
      ProcessInfo.processInfo.environment["FE_KEEP_VISIBLE"] != "1"
    p.collectionBehavior = [.moveToActiveSpace]
    p.isOpaque = true
    p.backgroundColor = .windowBackgroundColor
    let host = NSHostingView(rootView: RootView().environmentObject(model))
    p.contentView = host
    p.center()
    panel = p

    model.hidePanel = { [weak self] in if self?.model.windowMode != true { self?.panel?.orderOut(nil) } }
    model.toggleWindowMode = { [weak self] in self?.switchWindowMode() }
    model.updateDockVisibility = { [weak self] in self?.applyDockVisibility() }
    model.showQuickPreview = { [weak self] path in guard let self else {return};self.quickPreview.toggle(path,parent:self.panel,autoplay:self.model.viewOptions.autoplayPreview) }
    model.showQuickPreviews = { [weak self] paths in guard let self else {return};self.quickPreview.toggle(paths,parent:self.panel,autoplay:self.model.viewOptions.autoplayPreview) }
    model.selectionDidChange = { [weak self] in
      guard let self,self.quickPreview.isVisible else {return}
      if let item=self.model.currentItem {self.quickPreview.update(item.path)} else if self.model.resultCount==0 {self.quickPreview.close()}
    }
    model.ensureSearchService = { [weak self] in self?.startSearchService() }
    model.updateLiveService = { [weak self] in
      guard let self else { return }
      if let process = self.serviceProcess, process.isRunning {
        process.terminationHandler = { [weak self] _ in Task { @MainActor in self?.serviceProcess = nil; self?.startSearchService() } }
        process.terminate()
      } else { self.startSearchService() }
    }
    applyWindowMode()
    startSearchService()
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
      Task { @MainActor in guard let self, self.panel?.isVisible == true else { return }; await self.model.pollUpdates() }
    }
    // A local monitor sees every key BEFORE the responder chain — the
    // text field's editor would otherwise swallow arrows, return and
    // characters long before they reached the panel's keyDown.
    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {
      [weak self] ev in
      guard let self else {return ev}
      if ev.window === self.quickPreview.panel {
        if [49,53].contains(ev.keyCode) {self.quickPreview.close();self.panel.makeKeyAndOrderFront(nil);self.model.focusResults();return nil}
        if [125,126].contains(ev.keyCode) {
          let direction=ev.keyCode == 125 ? 1 : -1
          if !self.quickPreview.step(direction) {self.model.select(self.model.selected+direction,trigger:.keyboard)}
          return nil
        }
        return ev
      }
      guard ev.window === self.panel else { return ev }
      return self.handleKey(ev) ? nil : ev
    }
    // FE_REMOTE=1: deterministic remote control for UI tests and power
    // users — write "query <text>" or "key <keycode> <modflags>" to
    // /tmp/fe-cmd and the app runs it through the real handlers.
    if ProcessInfo.processInfo.environment["FE_REMOTE"] == "1" {
      Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) {
        [weak self] _ in
        guard let self,
              let s = try? String(contentsOfFile: "/tmp/fe-cmd")
        else { return }
        try? FileManager.default.removeItem(atPath: "/tmp/fe-cmd")
        Task { @MainActor in self.handleRemote(s.trimmingCharacters(in: .whitespacesAndNewlines)) }
      }
    }
    installStatusItem()
    registerHotkey()
    model.bootstrap()
    showPanel()
  }

  func handleKey(_ ev: NSEvent) -> Bool {
    let m = model
    // Only real modifiers — arrows/nav keys carry .function on physical
    // keyboards and .numericPad on keypads; masking those out is what
    // makes ↑↓ actually fire on real hardware.
    let mods = ev.modifierFlags.intersection(
      [.command, .option, .control, .shift])
    if mods.isEmpty && ev.keyCode == 53 {
      if m.showHelp {m.showHelp=false;return true}
      if m.showActions {m.showActions=false;m.actFilter="";return true}
      if m.showOptions {m.showOptions=false;return true}
      if m.columnFilter != nil {m.columnFilter=nil;return true}
      if m.showSortBar {m.showSortBar=false;return true}
    }
    // These work from anywhere — panel open, action menu open, typing.
    switch (mods, ev.keyCode) {
    case ([.command], 12): NSApp.terminate(nil); return true      // ⌘Q
    case ([.command], 13): panel?.orderOut(nil); return true      // ⌘W
    case ([.command, .shift], 13): switchWindowMode(); return true
    case ([.command], 43): m.showOptions.toggle(); return true
    case ([.command, .shift], 2): m.saveSearch(); return true
    case ([.command], 37),([.command],3):
      m.focusSearch(selectAll:true);return true
    case ([.command],9):
      if m.resultFocused {m.focusSearch(selectAll:true)};return false
    case ([.command,.shift],3):m.columnFilter=m.columnFilter == nil ? .name : nil;return true
    case ([.command,.option],3):m.performSelected(.folder);return true
    case ([.command,.shift],1):m.showSortBar.toggle();return true
    case ([.command,.shift],35):m.setQueryOption("favorites",SearchQueryOptions.value("favorites",in:m.query)=="true" ? nil : "true");return true
    case ([.command], 40):                                        // ⌘K
      m.showActions ? (m.showActions = false) : m.showActionsPanel()
      return true
    default: break
    }
    if m.editingColumnFilter {return false}
    if m.showOptions {
      if mods.isEmpty && ev.keyCode == 53 { m.showOptions = false; return true }
      return false
    }
    // Help overlay: everything closes it, nothing else.
    if m.showHelp {
      m.showHelp = false
      return true
    }
    if mods == [.command] && ev.keyCode == 44 {                    // ⌘/
      if m.showHelp { m.showHelp = false } else { m.showHelpPanel() }
      return true
    }
    // Action panel: its own navigation — arrows, type-to-filter, submenus.
    if m.showActions {
      switch (mods, ev.keyCode) {
      case ([],48):m.showActions=false;return true
      case ([], 125), ([.control], 45):
        m.actSel = min(m.actSel + 1, m.actItems.count - 1); return true
      case ([], 126), ([.control], 35):
        m.actSel = max(m.actSel - 1, 0); return true
      case ([.command], 126): m.actSel = 0; return true
      case ([.command], 125):
        m.actSel = max(0, m.actItems.count - 1); return true
      case ([], 36), ([], 76), ([], 124):
        m.runAction(m.actSel); return true                        // ↵ or →
      case ([], 123):                                             // ← back
        if m.actMenu != .root {
          m.actMenu = .root; m.actSel = 0; m.actFilter = ""
        }
        return true
      case ([], 53):                                              // esc
        if !m.actFilter.isEmpty { m.actFilter = "" }
        else if m.actMenu != .root { m.actMenu = .root }
        else { m.showActions = false }
        m.actSel = 0
        return true
      case ([], 51):                                              // ⌫ edits filter
        if !m.actFilter.isEmpty { m.actFilter.removeLast(); m.actSel = 0 }
        return true
      default:
        // type-to-filter: printable characters narrow the action list
        if (mods.isEmpty || mods == [.shift]),let s=ev.characters,ResultNavigation.isSearchText(s) {
          m.actFilter += s; m.actSel = 0
        }
        return true
      }
    }
    switch (mods, ev.keyCode) {
    case ([.shift],125) where m.resultFocused: m.extendSelection(1);return true
    case ([.shift],126) where m.resultFocused: m.extendSelection(-1);return true
    case ([],49):
      if ResultNavigation.previewOnSpace(resultFocused:m.resultFocused,editingFilter:m.editingColumnFilter) {
        m.performSelected(.preview);return true
      }
      return false
    case ([], 125), ([.control], 45):                             // ↓ / ^N
      m.select(ResultNavigation.arrow(1,current:m.selected,count:m.resultCount,focus:m.inputFocus), trigger:.keyboard)
      return true
    case ([], 126), ([.control], 35):                             // ↑ / ^P
      m.select(ResultNavigation.arrow(-1,current:m.selected,count:m.resultCount,focus:m.inputFocus), trigger:.keyboard);return true
    case ([.option], 126): _ = m.historyUp(); return true
    case ([.option], 125): _ = m.historyDown(); return true
    case ([], 116):                                               // PgUp
      m.select(m.selected - max(1, Int((panel.frame.height - 110) / 40)), trigger: .keyboard); return true
    case ([], 121):                                               // PgDn
      m.select(m.selected + max(1, Int((panel.frame.height - 110) / 40)), trigger: .keyboard)
      return true
    // While the caret is in the search field, Home/End and ⌘↑/⌘↓ stay
    // text navigation instead of stealing the line jumps.
    case ([], 115), ([.command], 126):                            // Home / ⌘↑
      guard m.resultFocused else {return false}
      m.jumpBoundary(last: false); return true
    case ([], 119), ([.command], 125):                            // End / ⌘↓
      guard m.resultFocused else {return false}
      m.jumpBoundary(last: true); return true
    case ([], 36), ([], 76):                                      // ↵ open
      if m.canSearchWeb {m.searchWeb(m.query)}
      else {m.openSelection()}
      return true
    case ([.command], 36), ([.command], 76):                      // ⌘↵ folder
      m.openSelectionFolder()
      return true
    case ([.option], 36), ([.option], 76):                        // ⌥↵ reveal
      if let it = m.currentItem { m.reveal(it.path) }
      return true
    case ([], 53):                                                // esc
      if m.resultFocused {m.focusSearch()} else if !m.query.isEmpty {m.clearQuery()} else {panel?.orderOut(nil)}
      return true
    case ([.command], 6):                                         // ⌘Z
      if m.inputFocus == .search, m.restoreClearedQuery() {return true}
      return false
    case ([],123) where m.resultFocused:m.focusSearch();return true
    case ([],124) where m.resultFocused:m.showActionsPanel();return true
    case ([],51) where m.resultFocused:
      if !m.query.isEmpty {m.query.removeLast()};m.focusSearch();return true
    case ([], 48): m.showActionsPanel(); return true              // tab
    case ([.shift], 48):                                          // ⇧Tab
      // Path mode: pop one path component (Raycast's ⇧Tab = parent dir).
      let q = m.query
      if q.hasPrefix("/") || q.hasPrefix("~") {
        var s = q.hasSuffix("/") ? String(q.dropLast()) : q
        s = (s as NSString).deletingLastPathComponent
        if s.isEmpty || s == "~" { s = s.isEmpty ? "/" : "~/" }
        m.query = s
        m.onQueryChange(s)
        return true
      }
      return false
    case ([.command], 2): m.showDetail.toggle(); return true      // ⌘D
    case ([.command], 34):                                        // ⌘I
      if let it = m.currentItem { m.getInfo(it.path) }; return true
    case ([.command], 35):                                        // ⌘P
      if let it = m.currentItem { m.togglePin(it.path) }; return true
    case ([.command], 31):                                        // ⌘O
      m.revealSelection(); return true
    case ([.command], 8):                                         // ⌘C
      if !m.resultFocused {return false}
      m.copySelectionPaths(); return true
    case ([.command, .shift], 8):                                 // ⌘⇧C
      if let it = m.currentItem { m.copyName(it.path) }; return true
    case ([.command, .option], 8):                                // ⌘⌥C
      if let it = m.currentItem { m.copyFile(it.path) }; return true
    case ([.command, .option, .shift], 8):                        // ⌘⌥⇧C
      if let it = m.currentItem { m.copyContents(it.path) }; return true
    case ([.command], 17):                                        // ⌘T
      if let it = m.currentItem { m.openTerminal(it.path) }; return true
    case ([.command], 16):                                        // ⌘Y
      m.performSelected(.preview);return true
    case ([.command], 15): m.rebuild(); return true               // ⌘R
    case ([.command], 51):                                        // ⌘⌫
      // Typing: the standard macOS way to delete the whole line.
      // In the results it keeps moving the selected file to the Trash.
      if m.resultFocused {if let it = m.currentItem { m.trash(it.path) }}
      else {m.clearQuery()}
      return true
    case ([.command, .option], 124): m.cycleScope(1); return true
    case ([.command, .option], 123): m.cycleScope(-1); return true
    // ⌘1..⌘6 scope switching
    case ([.command], 18): m.scope = .home; return true
    case ([.command], 19): m.scope = .downloads; return true
    case ([.command], 20): m.scope = .documents; return true
    case ([.command], 21): m.scope = .applications; return true
    case ([.command], 23): m.scope = .all; return true
    case ([.command], 22): m.scope = .custom; return true
    default:
      if m.resultFocused,(mods.isEmpty || mods == [.shift]),let text=ev.characters,ResultNavigation.isSearchText(text) {
        m.query=SearchQueryOptions.replacingText(text,in:m.query);m.focusSearch();return true
      }
      return false
    }
  }

  /// Remote-test channel (FE_REMOTE=1): same code path as real keys.
  func handleRemote(_ s: String) {
    let parts = s.split(separator: " ", maxSplits: 1)
    switch parts.first {
    case "query":
      let q = parts.count > 1 ? String(parts[1]) : ""
      if panel?.isVisible != true { showPanel() }
      model.query = q
      model.onQueryChange(q)
    case "key":
      let kv = parts.count > 1 ? parts[1].split(separator: " ") : []
      guard let code = kv.first.flatMap({ Int($0) }) else { return }
      let mods = NSEvent.ModifierFlags(
        rawValue: UInt(kv.dropFirst().first.flatMap { Int($0) } ?? 0))
      if let ev = NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: mods,
        timestamp: 0, windowNumber: panel?.windowNumber ?? 0,
        context: nil, characters: "", charactersIgnoringModifiers: "",
        isARepeat: false, keyCode: UInt16(code)) {
        _ = handleKey(ev)
      }
    case "type":
      let text = parts.count > 1 ? String(parts[1]) : ""
      for ch in text {
        if let ev = NSEvent.keyEvent(
          with: .keyDown, location: .zero, modifierFlags: [],
          timestamp: 0, windowNumber: panel?.windowNumber ?? 0,
          context: nil, characters: String(ch),
          charactersIgnoringModifiers: String(ch),
          isARepeat: false, keyCode: 0) {
          _ = handleKey(ev)
        }
      }
    case "state":
      let m = model
      let s = """
        query=\(m.query)
        items=\(m.items.count) top=\(m.items.prefix(3).map(\.name))
        recents=\(m.recents.count) rtop=\(m.recents.prefix(4).map(\.name))
        selected=\(m.selected) actSel=\(m.actSel) actMenu=\(m.actMenu)
        showActions=\(m.showActions) filter=\(m.actFilter)
        pinned=\(m.pinnedPaths) lastMs=\(m.lastMs) toast=\(m.toast)
        help=\(m.showHelp) sec=\(m.visibleItems.indices.prefix(6).map { m.headerBefore($0) ?? "-" })
        visible=\(panel?.isVisible == true)
        """
      try? s.write(toFile: "/tmp/fe-state",
                   atomically: true, encoding: .utf8)
    case "show": showPanel()
    case "hide": panel?.orderOut(nil)
    default: break
    }
  }

  @objc func showPanel() {
    preparePanelFocus()
    panel?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    // Target the search field directly; never send selectAll to the results table.
    DispatchQueue.main.async { [weak self] in self?.focusPanelSearch() }
  }
  func preparePanelFocus() {model.inputFocus = .search}
  func focusPanelSearch() {
    guard model.inputFocus == .search else {return}
    model.focusSearch(selectAll:true)
  }

  private func installApplicationMenu() {
    let menu = NSMenu()
    let applicationItem = NSMenuItem(), applicationMenu = NSMenu(title: "Find Everything")
    applicationMenu.addItem(NSMenuItem(title: "Quit Find Everything", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    applicationItem.submenu = applicationMenu; menu.addItem(applicationItem)
    let editItem = NSMenuItem(), editMenu = NSMenu(title: "Edit")
    for (title, action, key) in [("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
      editMenu.addItem(NSMenuItem(title: title, action: Selector(action), keyEquivalent: key))
    }
    editItem.submenu = editMenu; menu.addItem(editItem)
    NSApp.mainMenu = menu
  }

  func startSearchService() {
    guard serviceProcess?.isRunning != true, let fe = model.fePath else { return }
    // An existing service is shared, never terminated by this app.
    if FileManager.default.fileExists(atPath: SearchSocket.path + ".json") {
      if let data = try? Data(contentsOf: URL(fileURLWithPath: SearchSocket.path + ".json")),
         let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         let pid = info["pid"] as? Int32, kill(pid, 0) == 0 { return }
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: fe)
    process.arguments = ["serve", "--socket", SearchSocket.path, "--parent"] + (model.autoUpdate ? ["--live"] : [])
    process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
    do { try process.run(); serviceProcess = process }
    catch { model.errorMessage = "Search service could not start: \(error.localizedDescription)" }
  }

  @objc func switchWindowMode() {
    model.windowMode.toggle()
    UserDefaults.standard.set(model.windowMode, forKey: "windowMode")
    model.recordInteraction("nav", trigger: model.windowMode ? "window" : "popup")
    applyWindowMode(); showPanel()
  }

  func applyWindowMode() {
    guard let panel else { return }
    if model.windowMode {
      panel.styleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
      panel.titleVisibility = .visible; panel.titlebarAppearsTransparent = false
      panel.isFloatingPanel = false; panel.level = .normal; panel.hidesOnDeactivate = false
      panel.collectionBehavior = [.managed, .fullScreenAuxiliary]
      panel.setContentSize(NSSize(width: 960, height: 620)); panel.center()
    } else {
      panel.styleMask = [.nonactivatingPanel, .titled, .fullSizeContentView]
      panel.titleVisibility = .hidden; panel.titlebarAppearsTransparent = true
      panel.isFloatingPanel = true; panel.level = .floating
      panel.hidesOnDeactivate = ProcessInfo.processInfo.environment["FE_KEEP_VISIBLE"] != "1"
      panel.collectionBehavior = [.moveToActiveSpace]
      panel.setContentSize(NSSize(width: 640, height: 420)); panel.center()
    }
    panel.minSize = NSSize(width: 640, height: 420)
  }

  func applyDockVisibility() {
    NSApp.setActivationPolicy(model.showDockIcon ? .regular : .accessory)
  }

  func togglePanel() {
    if NSApp.isActive && panel?.isVisible == true && panel?.isOnActiveSpace == true {
      panel?.orderOut(nil)
    } else { showPanel() }
  }

  func installStatusItem() {
    guard statusItem == nil else {return}
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    item.autosaveName="FindEverything.Search"
    item.isVisible=true
    let image=NSImage(systemSymbolName:"magnifyingglass.circle.fill",accessibilityDescription:"Find Everything")
    image?.isTemplate=true
    item.button?.image=image
    item.button?.toolTip = "Find Everything"
    let menu = NSMenu()
    let show = NSMenuItem(title: "Show Find Everything", action: #selector(showPanel), keyEquivalent: "")
    show.target = self; menu.addItem(show)
    let mode = NSMenuItem(title: "Switch Window / Popup", action: #selector(switchWindowMode), keyEquivalent: "")
    mode.target = self; menu.addItem(mode)
    let folder = NSMenuItem(title: "Index Folder or Project…", action: #selector(chooseFolder), keyEquivalent: "")
    folder.target = self; menu.addItem(folder)
    menu.addItem(.separator())
    let quit = NSMenuItem(title: "Quit Find Everything", action: #selector(quitApp), keyEquivalent: "")
    quit.target = self; menu.addItem(quit)
    item.menu = menu
    statusItem = item
  }

  @objc func chooseFolder() { showPanel(); model.indexFolder() }
  @objc func quitApp() { NSApp.terminate(nil) }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    showPanel()
    return true
  }

  func recordHotkeyStatus() {
    let data: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier,
      "registrationStatus": Int(hotkeyRegistration), "handlerStatus": Int(hotkeyHandlerStatus),
      "events": hotkeyEvents, "active": NSApp.isActive, "panelVisible": panel?.isVisible ?? false]
    do {
      try FileManager.default.createDirectory(at: FEDirs.support, withIntermediateDirectories: true)
      let url = FEDirs.support.appendingPathComponent("hotkey-status.json")
      try JSONSerialization.data(withJSONObject: data).write(to: url, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    } catch { NSLog("Find Everything hotkey diagnostics: %@", error.localizedDescription) }
  }

  // Carbon global hotkey: Option+Space
  func registerHotkey() {
    var spec = EventTypeSpec(
      eventClass: OSType(kEventClassKeyboard),
      eventKind: UInt32(kEventHotKeyPressed))
    hotkeyHandlerStatus = InstallEventHandler(GetApplicationEventTarget(), { _, _, _ -> OSStatus in
      Task { @MainActor in
        guard let app = AppDelegate.shared else { return }
        app.hotkeyEvents += 1
        app.togglePanel()
        app.recordHotkeyStatus()
      }
      return noErr
    }, 1, &spec, nil, &hotkeyHandler)
    let id = EventHotKeyID(signature: OSType(0x4645), id: 1) // 'FE'
    if hotkeyHandlerStatus == noErr {
      // Exclusive: without it macOS notifies every app that registered the same
      // combination, so ⌥Space opened Find Everything and the other launcher.
      hotkeyRegistration = RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), id,
                          GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &hotkeyRef)
    } else { hotkeyRegistration = hotkeyHandlerStatus }
    if hotkeyHandlerStatus != noErr || hotkeyRegistration != noErr {
      model.shortcutWarning = hotkeyRegistration == eventHotKeyExistsErr
        ? "⌥Space is already owned by another app. Free it there or open Find Everything from the menu bar icon."
        : "⌥Space is unavailable. Open Find Everything from the menu bar icon."
    }
    recordHotkeyStatus()
  }

  func applicationWillTerminate(_ notification: Notification) {
    model.saveStartupView()
    quickPreview.shutdown()
    model.stopIndexing()
    if serviceProcess?.isRunning == true { serviceProcess?.terminate() }
    if let hotkeyRef { UnregisterEventHotKey(hotkeyRef) }
    if let hotkeyHandler { RemoveEventHandler(hotkeyHandler) }
    if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
  }

  func applicationShouldTerminateAfterLastWindowClosed(
    _ s: NSApplication) -> Bool { false }
}

struct RootView: View {
  @EnvironmentObject var m: Model
  @Environment(\.colorScheme) var scheme
  var body: some View {
    Group {
      if m.setupNeeded { SetupView() } else { SearchView() }
    }
    .frame(minWidth: 640, maxWidth: .infinity, minHeight: 420, maxHeight: .infinity)
    .background(SearchPalette.forScheme(scheme).paper)
    .preferredColorScheme(m.display.colorScheme)
    .onChange(of:m.display.habitRanking) { _ in m.onQueryChange(m.query,force:true) }
    .cornerRadius(12)
    .shadow(radius: 20)
  }
}

extension Collection {
  subscript(safe i: Index) -> Element? {
    indices.contains(i) ? self[i] : nil
  }
}

MainActor.assumeIsolated {
  let app = NSApplication.shared
  let delegate = AppDelegate()
  app.delegate = delegate
  withExtendedLifetime(delegate) { app.run() }
}

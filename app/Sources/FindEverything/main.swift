import SwiftUI
import AppKit
import Carbon
import Foundation

// MARK: - Paths & tool discovery

enum FEDirs {
  static let support = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/FindEverything")
  static let binDir = support.appendingPathComponent("bin")
}

func toolPath(_ name: String) -> String? {
  let candidates = [
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

enum FEScope: String, CaseIterable, Identifiable {
  case home, downloads, documents, applications, all, custom
  var id: String { rawValue }
  var label: String {
    switch self {
    case .home: "Home"
    case .downloads: "Downloads"
    case .documents: "Documents"
    case .applications: "Applications"
    case .all: "All (/)"
    case .custom: "Custom"
    }
  }
}

struct FEItem: Identifiable, Hashable {
  let path: String
  var id: String { path }
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
  @Published var query = ""
  @Published var items: [FEItem] = []
  @Published var recents: [FEItem] = []
  @Published var selected = 0
  @Published var showActions = false
  @Published var scope: FEScope = FEScope(
    rawValue: UserDefaults.standard.string(forKey: "scope") ?? "home"
  ) ?? .home
  @Published var searching = false
  @Published var indexing = false
  @Published var showDetail = false
  @Published var setupNeeded = false
  @Published var setupLog = "Checking tools…"
  @Published var setupRunning = false
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

  var fePath: String? { toolPath("fe") }
  private var searchTask: Task<Void, Never>?
  private var proc: Process?
  private var metaCache: [String: [FileAttributeKey: Any]] = [:]

  // User habits live in a JSON file under Application Support — app data,
  // not a preference. Works regardless of how the binary was launched and
  // stays inspectable/shareable with the fe CLI.
  static var opensFile: URL {
    FEDirs.support.appendingPathComponent("opens.json")
  }
  static var pinsFile: URL {
    FEDirs.support.appendingPathComponent("pins.json")
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
    guard t.count >= 2 else { return }
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
  /// Pinned items float above recents and are boosted over other results.
  @Published private(set) var pinnedPaths: [String] = []
  var pinnedSet: Set<String> { Set(pinnedPaths) }
  @Published var lastMs = 0
  @Published var showHelp = false

  func loadPins() {
    pinnedPaths = (try? JSONDecoder().decode(
      [String].self,
      from: Data(contentsOf: Model.pinsFile))) ?? []
  }

  func togglePin(_ p: String) {
    if let i = pinnedPaths.firstIndex(of: p) {
      pinnedPaths.remove(at: i); showToast("Unpinned")
    } else {
      pinnedPaths.insert(p, at: 0); showToast("Pinned to top")
    }
    if let d = try? JSONEncoder().encode(pinnedPaths) {
      try? FileManager.default.createDirectory(
        at: FEDirs.support, withIntermediateDirectories: true)
      try? d.write(to: Model.pinsFile, options: .atomic)
    }
    loadRecents()
    items = habitBoost(items)
  }
  private var opens: [String: Double] {
    guard let data = try? Data(contentsOf: Model.opensFile),
          let d = try? JSONSerialization.jsonObject(with: data)
              as? [String: Double]
    else { return [:] }
    return d
  }

  func recordOpen(_ p: String) {
    var d = opens
    d[p] = Date().timeIntervalSince1970
    if d.count > 150 {
      let cutoff = d.values.sorted()[d.count - 150]
      d = d.filter { $0.value >= cutoff }
    }
    saveOpens(d)
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
    let l = visibleItems
    guard i < l.count else { return nil }
    let t = tier(l[i])
    if i == 0 || tier(l[i - 1]) != t { return Model.tierTitles[t] }
    return nil
  }
  func habitBoost(_ list: [FEItem]) -> [FEItem] {
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
    if let m = metaCache[p] { return m }
    let attrs = try? FileManager.default.attributesOfItem(atPath: p)
    if let attrs { metaCache[p] = attrs }
    return attrs
  }

  func bootstrap() {
    loadPins()
    loadHistory()
    loadRecents()
    let missing = ["fe", "fd", "rg", "fzf"].filter { toolPath($0) == nil }
    if missing.isEmpty {
      ensureIndexIfNeeded()
    } else {
      setupNeeded = true
      setupLog = "Missing: \(missing.joined(separator: ", "))"
    }
  }

  func ensureIndexIfNeeded() {
    let idx = NSHomeDirectory() + "/.cache/hypersearch/index-home.txt"
    guard !FileManager.default.fileExists(atPath: idx) else { return }
    indexing = true
    Task {
      await runTool("index", "--scope", scope.rawValue)
      indexing = false
    }
  }

  func onQueryChange(_ q: String) {
    // Query edits leave history mode — unless the edit IS the history
    // entry we just navigated to (text match beats a flag: onQueryChange
    // can fire twice — binding onChange plus an explicit call).
    let qt = q.trimmingCharacters(in: .whitespaces)
    if !(histPos >= 0 && histPos < history.count
         && history[histPos] == qt) {
      histPos = -1
    }
    searchTask?.cancel()
    proc?.terminate()
    let t = q.trimmingCharacters(in: .whitespaces)
    guard t.count >= 2, !indexing else { items = []; selected = 0; return }
    // Path passthrough: a pasted or typed absolute/~/ path that exists
    // resolves directly — Enter opens it, no index needed.
    let expanded = (t as NSString).expandingTildeInPath
    if (t.hasPrefix("/") || t.hasPrefix("~")),
       FileManager.default.fileExists(atPath: expanded) {
      items = [FEItem(path: expanded)]
      selected = 0
      searching = false
      return
    }
    searchTask = Task {
      try? await Task.sleep(nanoseconds: 120_000_000)
      guard !Task.isCancelled else { return }
      searching = true
      let t0 = Date()
      let out = await runTool("search", "--scope", scope.rawValue, "-n", "80", t)
      guard !Task.isCancelled else { return }
      items = habitBoost(
        out.split(separator: "\n").map { FEItem(path: String($0)) })
      lastMs = Int(-t0.timeIntervalSinceNow * 1000)
      selected = 0
      searching = false
    }
  }

  func rebuild() {
    indexing = true
    Task {
      await runTool("index", "--scope", scope.rawValue)
      indexing = false
      onQueryChange(query)
    }
  }

  /// Runs `fe <args>`, returns stdout. Cancellable via proc.terminate().
  private func runTool(_ args: String...) async -> String {
    guard let fe = fePath else { return "" }
    return await withCheckedContinuation { cont in
      DispatchQueue.global().async {
        let p = Process()
        let pipe = Pipe()
        p.executableURL = URL(fileURLWithPath: fe)
        p.arguments = args
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { cont.resume(returning: ""); return }
        Task { @MainActor in self.proc = p }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        cont.resume(returning: String(data: data, encoding: .utf8) ?? "")
      }
    }
  }

  // MARK: actions

  var currentItem: FEItem? {
    let list = visibleItems
    return list[safe: selected]
  }

  var visibleItems: [FEItem] {
    query.trimmingCharacters(in: .whitespaces).count >= 2 ? items : recents
  }

  func open(_ p: String) {
    recordQuery(query)
    recordOpen(p)
    NSWorkspace.shared.open(URL(fileURLWithPath: p))
    hidePanel?()
  }
  func openFolder(_ p: String) {
    var isDir: ObjCBool = false
    FileManager.default.fileExists(atPath: p, isDirectory: &isDir)
    let dir = isDir.boolValue ? p : (p as NSString).deletingLastPathComponent
    NSWorkspace.shared.open(URL(fileURLWithPath: dir))
    hidePanel?()
  }
  func reveal(_ p: String) {
    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)])
    hidePanel?()
  }
  /// No-results fallback: ↵ with a dead query opens a web search instead
  /// of being a dead end (Raycast fallback-command pattern).
  func searchWeb(_ q: String) {
    let e = q.addingPercentEncoding(
      withAllowedCharacters: .urlQueryAllowed) ?? q
    if let u = URL(string: "https://duckduckgo.com/?q=\(e)") {
      NSWorkspace.shared.open(u)
    }
    hidePanel?()
  }
  func quickLook(_ p: String) {
    let pr = Process()
    pr.executableURL = URL(fileURLWithPath: "/usr/bin/qlmanage")
    pr.arguments = ["-p", p]
    pr.standardOutput = FileHandle.nullDevice
    pr.standardError = FileHandle.nullDevice
    try? pr.run()
  }
  func trash(_ p: String) {
    var d = opens
    d.removeValue(forKey: p)
    saveOpens(d)
    try? FileManager.default.trashItem(
      at: URL(fileURLWithPath: p), resultingItemURL: nil)
    items.removeAll { $0.path == p }
    recents.removeAll { $0.path == p }
    selected = max(0, min(selected, visibleItems.count - 1))
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
                hint: "↵") { _, p in
          NSWorkspace.shared.open(
            [URL(fileURLWithPath: p)], withApplicationAt: app,
            configuration: NSWorkspace.OpenConfiguration())
        }
      }.filtered(actFilter)
    case .scopes:
      return FEScope.allCases.map { s in
        ActItem(
          title: s.label,
          hint: "⌘\((FEScope.allCases.firstIndex(of: s) ?? 0) + 1)"
        ) { m, _ in m.scope = s }
      }.filtered(actFilter)
    case .root: break
    }
    let curPath = currentItem?.path ?? ""
    let isPinned = pinnedSet.contains(curPath)
    let list: [ActItem] = [
      ActItem(title: "Open", hint: "↵") { m, p in m.open(p) },
      ActItem(title: "Open Containing Folder", hint: "⌘↵") { m, p in m.openFolder(p) },
      ActItem(title: "Reveal in Finder", hint: "⌘O") { m, p in m.reveal(p) },
      ActItem(title: "Open With…", hint: "→") { m, _ in m.pushOpenWith() },
      ActItem(title: "Open in Terminal", hint: "⌘T") { m, p in m.openTerminal(p) },
      ActItem(title: "Quick Look", hint: "⌘Y") { m, p in m.quickLook(p) },
      ActItem(title: isPinned ? "Unpin" : "Pin to Top", hint: "⌘P") { m, p in m.togglePin(p) },
      ActItem(title: "Copy Path", hint: "⌘C") { m, p in m.copyPath(p) },
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
      ActItem(title: "Rebuild Index", hint: "⌘R") { m, _ in m.rebuild() },
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
    guard let it = currentItem, let a = actItems[safe: i] else { return }
    a.run(self, it.path)
    // A submenu push keeps the panel open; everything else closes it.
    if actMenu != .root { actSel = 0; actFilter = "" }
    else { showActions = false; actFilter = "" }
  }
}

extension Array where Element == Model.ActItem {
  func filtered(_ f: String) -> [Model.ActItem] {
    f.isEmpty ? self
      : filter { $0.title.localizedCaseInsensitiveContains(f) }
  }
}

extension FEScope {
  func next() -> FEScope {
    let all = FEScope.allCases
    let i = all.firstIndex(of: self) ?? 0
    return all[(i + 1) % all.count]
  }
  func prev() -> FEScope {
    let all = FEScope.allCases
    let i = all.firstIndex(of: self) ?? 0
    return all[(i - 1 + all.count) % all.count]
  }
}

// MARK: - Installer (GitHub release binaries, no brew/sudo needed)

struct ToolSpec {
  let name: String
  let repo: String
  /// substring that identifies the right asset for this arch
  let archToken: String
}

enum Downloader {
  #if arch(arm64)
  static let isArm = true
  #else
  static let isArm = false
  #endif

  static var specs: [ToolSpec] {
    let arm = isArm
    return [
      ToolSpec(name: "fe", repo: "Supersynergy/find-everything",
               archToken: arm ? "fe-darwin-arm64" : "fe-darwin-x64"),
      ToolSpec(name: "fd", repo: "sharkdp/fd",
               archToken: arm ? "aarch64-apple-darwin" : "x86_64-apple-darwin"),
      ToolSpec(name: "rg", repo: "BurntSushi/ripgrep",
               archToken: arm ? "aarch64-apple-darwin" : "x86_64-apple-darwin"),
      ToolSpec(name: "fzf", repo: "junegunn/fzf",
               archToken: arm ? "darwin_arm64" : "darwin_amd64"),
    ]
  }

  /// Resolves latest release asset URL containing the arch token.
  static func latestAsset(repo: String, token: String) async throws -> URL {
    let api = URL(string: "https://api.github.com/repos/\(repo)/releases/latest")!
    let (data, _) = try await URLSession.shared.data(from: api)
    let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    for a in (json["assets"] as? [[String: Any]]) ?? [] {
      if let n = a["name"] as? String, n.contains(token),
         let u = a["browser_download_url"] as? String {
        return URL(string: u)!
      }
    }
    throw NSError(domain: "fe", code: 1,
                  userInfo: [NSLocalizedDescriptionKey: "no asset \(token) in \(repo)"])
  }

  /// Downloads a release asset and installs the binary into binDir.
  static func install(_ spec: ToolSpec, into binDir: URL) async throws {
    let url = try await latestAsset(repo: spec.repo, token: spec.archToken)
    let (tmp, _) = try await URLSession.shared.download(from: url)
    let work = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: work) }

    if url.path.hasSuffix(".zip") {
      try run("/usr/bin/ditto", ["-x", "-k", tmp.path, work.path])
    } else if url.path.hasSuffix(".tar.gz") || url.path.hasSuffix(".tgz") {
      try run("/usr/bin/tar", ["-xzf", tmp.path, "-C", work.path])
    } else {
      // raw binary (fe release assets)
      try FileManager.default.moveItem(
        at: tmp, to: work.appendingPathComponent(spec.name))
    }
    // find the executable inside whatever was unpacked
    let fm = FileManager.default
    let en = fm.enumerator(at: work, includingPropertiesForKeys: nil)!
    let all = en.allObjects as? [URL] ?? []
    let found = all.first { $0.lastPathComponent == spec.name }
    guard let src = found else {
      throw NSError(domain: "fe", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "\(spec.name) not in archive"])
    }
    let dst = binDir.appendingPathComponent(spec.name)
    try? fm.removeItem(at: dst)
    try fm.copyItem(at: src, to: dst)
    try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dst.path)
  }

  private static func run(_ cmd: String, _ args: [String]) throws {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: cmd)
    p.arguments = args
    try p.run()
    p.waitUntilExit()
    if p.terminationStatus != 0 {
      throw NSError(domain: "fe", code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "\(cmd) failed"])
    }
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
  let item: FEItem
  let selected: Bool
  let meta: [FileAttributeKey: Any]?
  var pinned: Bool = false
  var isDir: Bool {
    (meta?[.type] as? FileAttributeType) == .typeDirectory
  }
  var body: some View {
    HStack(spacing: 10) {
      Image(nsImage: NSWorkspace.shared.icon(forFile: item.path))
        .resizable().frame(width: 26, height: 26)
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: 4) {
          if pinned {
            Image(systemName: "pin.fill")
              .font(.system(size: 8)).foregroundStyle(.secondary)
          }
          Text(item.name).font(.system(size: 13, weight: .medium))
            .lineLimit(1).truncationMode(.middle)
        }
        Text(item.dir).font(.system(size: 11))
          .foregroundStyle(.secondary).lineLimit(1)
      }
      Spacer()
      if isDir {
        Text("Folder").font(.system(size: 9, weight: .medium))
          .padding(.horizontal, 5).padding(.vertical, 2)
          .background(.quaternary).cornerRadius(4)
      } else {
        let ext = (item.path as NSString).pathExtension.uppercased()
        if !ext.isEmpty {
          Text(ext).font(.system(size: 9, weight: .medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 5).padding(.vertical, 2)
            .background(.quaternary).cornerRadius(4)
        }
        if let n = meta?[.size] as? NSNumber {
          Text(humanSize(n.doubleValue)).font(.system(size: 10))
            .foregroundStyle(.tertiary)
        }
      }
      if let d = meta?[.modificationDate] as? Date {
        Text(relTime(d)).font(.system(size: 10))
          .foregroundStyle(.tertiary).frame(width: 28, alignment: .trailing)
      }
    }
    .padding(.horizontal, 12).padding(.vertical, 5)
    .background(selected ? Color.accentColor.opacity(0.25) : .clear)
    .contentShape(Rectangle())
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
      Text("Setup downloads the search tools it needs — no admin rights,\nno Spotlight, about 20 MB.")
        .multilineTextAlignment(.center).foregroundStyle(.secondary)
        .font(.system(size: 12))
      Text(m.setupLog).font(.system(size: 11, design: .monospaced))
        .foregroundStyle(.secondary).lineLimit(3)
      if m.setupRunning { ProgressView().scaleEffect(0.8) }
      Button(m.setupRunning ? "Installing…" : "Install tools") {
        install()
      }
      .disabled(m.setupRunning)
      .keyboardShortcut(.defaultAction)
    }
    .padding(28).frame(maxWidth: .infinity, maxHeight: .infinity)
  }
  func install() {
    Task { @MainActor in
      m.setupRunning = true
      do {
        try FileManager.default.createDirectory(
          at: FEDirs.binDir, withIntermediateDirectories: true)
        for spec in Downloader.specs where toolPath(spec.name) == nil {
          m.setupLog = "Downloading \(spec.name)…"
          try await Downloader.install(spec, into: FEDirs.binDir)
        }
        m.setupLog = "Building index — first run takes a moment…"
        m.ensureIndexIfNeeded()
        while m.indexing { try await Task.sleep(nanoseconds: 400_000_000) }
        m.setupNeeded = false
      } catch {
        m.setupLog = "Failed: \(error.localizedDescription)"
        m.setupRunning = false
      }
    }
  }
}

struct SearchView: View {
  @EnvironmentObject var m: Model
  @FocusState private var fieldFocused: Bool

  /// Right-click menu on a result row — mirrors the ⌘K panel for the mouse.
  @ViewBuilder
  private func rowMenu(_ it: FEItem) -> some View {
    Button("Open") { m.open(it.path) }
    Button("Open Containing Folder") { m.openFolder(it.path) }
    Button("Reveal in Finder") { m.reveal(it.path) }
    Menu("Open With…") {
      let apps = NSWorkspace.shared.urlsForApplications(
        toOpen: URL(fileURLWithPath: it.path))
      ForEach(apps, id: \.self) { app in
        Button(app.deletingPathExtension().lastPathComponent) {
          NSWorkspace.shared.open(
            [URL(fileURLWithPath: it.path)], withApplicationAt: app,
            configuration: NSWorkspace.OpenConfiguration())
        }
      }
    }
    Button("Open in Terminal") { m.openTerminal(it.path) }
    Button("Quick Look") { m.quickLook(it.path) }
    Button(m.pinnedSet.contains(it.path) ? "Unpin" : "Pin to Top") {
      m.togglePin(it.path)
    }
    Divider()
    Button("Copy Path") { m.copyPath(it.path) }
    Button("Copy Name") { m.copyName(it.path) }
    Button("Copy File") { m.copyFile(it.path) }
    Button("Copy Contents") { m.copyContents(it.path) }
    Divider()
    Button("Duplicate") { m.duplicate(it.path) }
    Button("Compress") { m.compress(it.path) }
    Button("Get Info") { m.getInfo(it.path) }
    Divider()
    Button("Move to Trash", role: .destructive) { m.trash(it.path) }
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
        TextField("Find every file on your Mac…", text: $m.query)
          .textFieldStyle(.plain).font(.system(size: 16))
          .focused($fieldFocused)
          .onChange(of: m.query) { m.onQueryChange($0) }
          .onAppear { fieldFocused = true }
          .onReceive(
            NotificationCenter.default.publisher(
              for: NSWindow.didBecomeKeyNotification)
          ) { _ in fieldFocused = true }
        Picker("", selection: $m.scope) {
          ForEach(FEScope.allCases) {
            Text($0.label).tag($0)
          }
        }
        .labelsHidden().frame(width: 110)
        .help("⌘1–⌘6 or ⌘K → Switch Scope")
        .onChange(of: m.scope) { s in
          UserDefaults.standard.set(s.rawValue, forKey: "scope")
          m.onQueryChange(m.query)
        }
      }
      .padding(.horizontal, 14).padding(.vertical, 11)
      Divider()
      Group {
        if m.indexing {
          VStack(spacing: 8) {
            ProgressView().scaleEffect(0.8)
            Text("Building index…").font(.system(size: 12))
              .foregroundStyle(.secondary)
          }.frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if m.query.trimmingCharacters(in: .whitespaces).count < 2 {
          if m.recents.isEmpty {
            Text("Every file on your Mac. No Spotlight needed.")
              .font(.system(size: 12)).foregroundStyle(.secondary)
              .frame(maxWidth: .infinity, maxHeight: .infinity)
          } else {
            VStack(alignment: .leading, spacing: 0) {
              ScrollView {
                LazyVStack(spacing: 0) {
                  ForEach(m.recents.indices, id: \.self) { i in
                    if let h = m.headerBefore(i) { SectionLabel(h) }
                    RowView(item: m.recents[i], selected: i == m.selected,
                            meta: m.meta(for: m.recents[i].path),
                            pinned: m.pinnedSet.contains(m.recents[i].path))
                      .id(i)
                      .onTapGesture(count: 2) { m.open(m.recents[i].path) }
                      .onTapGesture(count: 1) { m.selected = i }
                      .onHover { if $0 { m.selected = i } }
                      .contextMenu { rowMenu(m.recents[i]) }
                      .onDrag {
                        NSItemProvider(
                          object: NSURL(fileURLWithPath: m.recents[i].path))
                      }
                  }
                }
              }
            }.frame(maxHeight: .infinity, alignment: .top)
          }
        } else if m.items.isEmpty {
          VStack(spacing: 6) {
            Text(m.searching ? "Searching…" : "No matches")
              .font(.system(size: 12)).foregroundStyle(.secondary)
            if !m.searching && m.query.count > 1 {
              Text("↵ search the web · try  ext:  in:  type:  !")
                .font(.system(size: 10)).foregroundStyle(.tertiary)
            }
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          HStack(spacing: 0) {
            ScrollViewReader { proxy in
              ScrollView {
                LazyVStack(spacing: 0) {
                  ForEach(m.items.indices, id: \.self) { i in
                    if let h = m.headerBefore(i) { SectionLabel(h) }
                    RowView(item: m.items[i], selected: i == m.selected,
                            meta: m.meta(for: m.items[i].path),
                            pinned: m.pinnedSet.contains(m.items[i].path))
                      .id(i)
                      .onTapGesture(count: 2) { m.open(m.items[i].path) }
                      .onTapGesture(count: 1) { m.selected = i }
                      .onHover { if $0 { m.selected = i } }
                      .contextMenu { rowMenu(m.items[i]) }
                      .onDrag {
                        NSItemProvider(
                          object: NSURL(fileURLWithPath: m.items[i].path))
                      }
                  }
                }
              }
              .onChange(of: m.selected) { i in
                withAnimation(.none) { proxy.scrollTo(i, anchor: .center) }
              }
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
        if !m.toast.isEmpty {
          Text(m.toast).font(.system(size: 10))
            .foregroundStyle(.secondary)
            .transition(.opacity)
        }
        Spacer()
        Text(m.searching
          ? "…"
          : m.query.count >= 2
            ? "\(m.items.count) results · \(m.lastMs)ms"
            : m.scope.label)
          .font(.system(size: 10)).foregroundStyle(.tertiary)
        Button { m.showHelp = true } label: {
          Image(systemName: "questionmark.circle")
            .font(.system(size: 13)).foregroundStyle(.secondary)
        }
        .buttonStyle(.plain).help("Keyboard shortcuts ⌘/")
        Button { m.showActionsPanel() } label: {
          Image(systemName: "ellipsis.circle")
            .font(.system(size: 13)).foregroundStyle(.secondary)
        }
        .buttonStyle(.plain).help("Actions ⌘K")
      }
      .padding(.horizontal, 14).padding(.vertical, 7)
    }
    .overlay(alignment: .trailing) {
      if m.showActions {
        ActionPanelView()
          .environmentObject(m)
          .transition(.move(edge: .trailing).combined(with: .opacity))
      }
    }
    .overlay(alignment: .center) {
      if m.showHelp {
        HelpView()
          .environmentObject(m)
          .transition(.opacity.combined(with: .scale(scale: 0.96)))
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
    ("History", "↑ on first row cycles past queries · ⇧Tab parent dir"),
    ("Open", "↵ open · ⌘↵ folder · ⌥↵ reveal · ⌘Y quick look"),
    ("Actions", "⌘K or Tab · type to filter · → submenu · ← back"),
    ("File", "⌘C path · ⌘⇧C name · ⌘⌥C file · ⌘⌥⇧C contents"),
    ("File 2", "⌘I info · ⌘P pin · ⌘⌫ trash"),
    ("Tools", "⌘T terminal · ⌘R rebuild index"),
    ("Scope", "⌘1–⌘6 · ⌘⌥← ⌘⌥→ cycle"),
    ("Query", "ext:md · *.pdf · type:image · !tmp · \"exact\" · a|b"),
    ("Query 2", "in:downloads · invoice in downloads · sort:new · size:>10m · dm:today"),
    ("Panel", "⌥Space toggle · ⌘W hide · ⌘Q quit · ⎋ back"),
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
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  static var shared: AppDelegate!
  let model = Model()
  var panel: KeyPanel!
  var hotkeyRef: EventHotKeyRef?
  var keyMonitor: Any?

  func applicationDidFinishLaunching(_ n: Notification) {
    AppDelegate.shared = self
    NSApp.setActivationPolicy(.accessory)

    let p = KeyPanel(
      contentRect: NSRect(x: 0, y: 0, width: 640, height: 420),
      styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView],
      backing: .buffered, defer: false)
    p.titleVisibility = .hidden
    p.titlebarAppearsTransparent = true
    p.isMovableByWindowBackground = true
    p.isFloatingPanel = true
    p.level = .floating
    // FE_KEEP_VISIBLE=1 keeps the panel up for screenshots/UI tests.
    p.hidesOnDeactivate =
      ProcessInfo.processInfo.environment["FE_KEEP_VISIBLE"] != "1"
    p.collectionBehavior = [.moveToActiveSpace]
    p.isOpaque = false
    p.backgroundColor = .clear
    let host = NSHostingView(rootView: RootView().environmentObject(model))
    p.contentView = host
    p.center()
    panel = p

    model.hidePanel = { [weak self] in self?.panel?.orderOut(nil) }
    // A local monitor sees every key BEFORE the responder chain — the
    // text field's editor would otherwise swallow arrows, return and
    // characters long before they reached the panel's keyDown.
    keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {
      [weak self] ev in
      guard let self, ev.window === self.panel else { return ev }
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
    // These work from anywhere — panel open, action menu open, typing.
    switch (mods, ev.keyCode) {
    case ([.command], 12): NSApp.terminate(nil); return true      // ⌘Q
    case ([.command], 13): panel?.orderOut(nil); return true      // ⌘W
    case ([.command], 40):                                        // ⌘K
      m.showActions ? (m.showActions = false) : m.showActionsPanel()
      return true
    default: break
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
        if (mods.isEmpty || mods == [.shift]),
           let s = ev.charactersIgnoringModifiers, !s.isEmpty,
           let c = s.unicodeScalars.first,
           c.value < 0xF700, !CharacterSet.controlCharacters.contains(c) {
          m.actFilter += s; m.actSel = 0
        }
        return true
      }
    }
    switch (mods, ev.keyCode) {
    case ([], 125), ([.control], 45):                             // ↓ / ^N
      if m.histPos >= 0 { _ = m.historyDown(); return true }
      m.selected = max(0, min(m.selected + 1, m.visibleItems.count - 1))
      return true
    case ([], 126), ([.control], 35):                             // ↑ / ^P
      if (m.selected == 0 || m.histPos >= 0) && m.historyUp() {
        return true
      }
      m.selected = max(m.selected - 1, 0); return true
    case ([], 116):                                               // PgUp
      m.selected = max(0, m.selected - 8); return true
    case ([], 121):                                               // PgDn
      m.selected = min(m.selected + 8, max(0, m.visibleItems.count - 1))
      return true
    case ([], 115), ([.command], 126):                            // Home / ⌘↑
      m.selected = 0; return true
    case ([], 119), ([.command], 125):                            // End / ⌘↓
      m.selected = max(0, m.visibleItems.count - 1); return true
    case ([], 36), ([], 76):                                      // ↵ open
      if let it = m.currentItem { m.open(it.path) }
      else if m.query.count > 1 && !m.searching {
        m.searchWeb(m.query) // dead query -> web fallback, not a dead end
      }
      return true
    case ([.command], 36), ([.command], 76):                      // ⌘↵ folder
      if let it = m.currentItem { m.openFolder(it.path) }
      return true
    case ([.option], 36), ([.option], 76):                        // ⌥↵ reveal
      if let it = m.currentItem { m.reveal(it.path) }
      return true
    case ([], 53):                                                // esc
      if !m.query.isEmpty { m.query = "" } else { panel?.orderOut(nil) }
      return true
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
      if let it = m.currentItem { m.reveal(it.path) }; return true
    case ([.command], 8):                                         // ⌘C
      if let it = m.currentItem { m.copyPath(it.path) }; return true
    case ([.command, .shift], 8):                                 // ⌘⇧C
      if let it = m.currentItem { m.copyName(it.path) }; return true
    case ([.command, .option], 8):                                // ⌘⌥C
      if let it = m.currentItem { m.copyFile(it.path) }; return true
    case ([.command, .option, .shift], 8):                        // ⌘⌥⇧C
      if let it = m.currentItem { m.copyContents(it.path) }; return true
    case ([.command], 17):                                        // ⌘T
      if let it = m.currentItem { m.openTerminal(it.path) }; return true
    case ([.command], 16):                                        // ⌘Y
      if let it = m.currentItem { m.quickLook(it.path) }; return true
    case ([.command], 15): m.rebuild(); return true               // ⌘R
    case ([.command], 51):                                        // ⌘⌫
      if let it = m.currentItem { m.trash(it.path) }; return true
    case ([.command, .option], 124): m.scope = m.scope.next(); return true
    case ([.command, .option], 123): m.scope = m.scope.prev(); return true
    // ⌘1..⌘6 scope switching
    case ([.command], 18): m.scope = .home; return true
    case ([.command], 19): m.scope = .downloads; return true
    case ([.command], 20): m.scope = .documents; return true
    case ([.command], 21): m.scope = .applications; return true
    case ([.command], 23): m.scope = .all; return true
    case ([.command], 22): m.scope = .custom; return true
    default: return false
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
    panel?.center()
    panel?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    // Raycast habit: reopening selects the previous query so typing replaces it.
    DispatchQueue.main.async {
      NSApp.sendAction(#selector(NSResponder.selectAll(_:)), to: nil, from: nil)
    }
  }

  func togglePanel() {
    panel?.isVisible == true ? panel?.orderOut(nil) : showPanel()
  }

  // Carbon global hotkey: Option+Space
  func registerHotkey() {
    var spec = EventTypeSpec(
      eventClass: OSType(kEventClassKeyboard),
      eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetEventDispatcherTarget(), { _, _, _ -> OSStatus in
      Task { @MainActor in AppDelegate.shared?.togglePanel() }
      return noErr
    }, 1, &spec, nil, nil)
    let id = EventHotKeyID(signature: OSType(0x4645), id: 1) // 'FE'
    RegisterEventHotKey(UInt32(kVK_Space), UInt32(optionKey), id,
                        GetEventDispatcherTarget(), 0, &hotkeyRef)
  }

  func applicationShouldTerminateAfterLastWindowClosed(
    _ s: NSApplication) -> Bool { false }
}

struct RootView: View {
  @EnvironmentObject var m: Model
  var body: some View {
    Group {
      if m.setupNeeded { SetupView() } else { SearchView() }
    }
    .frame(width: 640, height: 420)
    .background(VisualEffect())
    .cornerRadius(12)
    .shadow(radius: 20)
  }
}

struct VisualEffect: NSViewRepresentable {
  func makeNSView(context: Context) -> NSVisualEffectView {
    let v = NSVisualEffectView()
    v.material = .hudWindow
    v.blendingMode = .behindWindow
    v.state = .active
    return v
  }
  func updateNSView(_ v: NSVisualEffectView, context: Context) {}
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
  app.run()
}

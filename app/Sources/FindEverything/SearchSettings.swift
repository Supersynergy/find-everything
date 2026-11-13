import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct SearchOptionsView: View {
  @EnvironmentObject var m: Model
  @Environment(\.colorScheme) var scheme
  @State private var page = "Appearance"
  @State private var openingExtension = ""
  @State private var openingError:String?
  private let pages = ["Appearance","Search","Opening","Indexes","Audio","Help"]
  private var palette: SearchPalette { .forScheme(scheme) }
  var body: some View {
    VStack(alignment:.leading,spacing:12) {
      HStack {
        Text("Settings").font(.system(size:18,weight:.semibold))
        Spacer()
        Button { m.showOptions = false } label: { Image(systemName:"xmark") }.buttonStyle(.plain).accessibilityLabel("Close settings")
      }
      Picker("Settings section",selection:$page) { ForEach(pages,id:\.self) { Text($0) } }.pickerStyle(.segmented)
      Divider()
      ScrollView {
        VStack(alignment:.leading,spacing:14) { content }.frame(maxWidth:.infinity,alignment:.leading).padding(.vertical,4)
      }
    }.font(.system(size:13)).foregroundStyle(palette.text).padding(18)
      .frame(width:520,height:440).background(palette.paper)
  }
  @ViewBuilder private var content: some View {
    switch page {
    case "Appearance": appearance
    case "Search": search
    case "Opening": opening
    case "Indexes": indexes
    case "Audio": audio
    default: help
    }
  }
  private var appearance: some View {
    VStack(alignment:.leading,spacing:12) {
      Picker("Theme",selection:$m.display.appearance) { Text("System").tag("system");Text("Light").tag("light");Text("Dark").tag("dark") }.pickerStyle(.segmented)
      HStack { Text("Text size"); Slider(value:$m.display.fontSize,in:12...17,step:1);Text("\(Int(m.display.fontSize)) pt").monospacedDigit().frame(width:42) }
      Toggle("Compact rows",isOn:$m.display.compact)
      Toggle("Alternating row backgrounds",isOn:$m.display.stripedRows)
      Toggle("File icons",isOn:$m.display.showIcons)
      Toggle("Keyboard hints",isOn:$m.viewOptions.keyboardHints)
      Text("Result columns").fontWeight(.semibold)
      HStack(spacing:16) { Toggle("Path",isOn:$m.display.showPath);Toggle("Type",isOn:$m.display.showType);Toggle("Size",isOn:$m.display.showSize);Toggle("Modified",isOn:$m.display.showModified) }
      Toggle("Preview pane",isOn:$m.showDetail)
      Toggle("Autoplay audio/video previews",isOn:$m.viewOptions.autoplayPreview)
      Toggle("Window mode",isOn:Binding(get:{m.windowMode},set:{ if $0 != m.windowMode {m.toggleWindowMode?()} }))
      Toggle("Show app in Dock",isOn:Binding(get:{m.showDockIcon},set:{m.showDockIcon=$0;UserDefaults.standard.set($0,forKey:"showDockIcon");m.updateDockVisibility?()}))
      Text("The Dock setting applies to both window and popup mode. Click a column heading to sort; the filter and sort bars expand separately. Missing file properties stay unknown.").font(.caption).foregroundStyle(palette.muted)
    }
  }
  private var search: some View {
    VStack(alignment:.leading,spacing:12) {
      Picker("Typing delay",selection:$m.display.debounceMs) { ForEach([0,60,120,200,350],id:\.self) { Text($0==0 ? "Immediately" : "\($0) ms").tag($0) } }
      Toggle("Learn from successful file opens",isOn:$m.display.habitRanking).onChange(of:m.display.habitRanking) {m.setLearningEnabled($0)}
      Button("Reset learned search preferences") {m.resetSearchLearning()}
      Text("Local only, shared with Raycast. Recent repeated selections help matching files, decay over time and never override explicit sorting. Typed searches alone do not train ranking.").font(.caption).foregroundStyle(palette.muted)
      Toggle("Group pinned and recent results",isOn:$m.display.groupResults).disabled(!m.display.habitRanking)
      Toggle("Remember new searches",isOn:$m.display.rememberHistory)
      Divider()
      Text("Visible results").fontWeight(.semibold)
      Button("Show all indexed files") {m.viewOptions.hideSystem=false;m.viewOptions.hideGenerated=false;m.viewOptions.hideHidden=false;m.viewOptions.hideNoise=false}
      Toggle("Hide macOS system folders",isOn:$m.viewOptions.hideSystem)
      Toggle("Hide generated files and build/cache folders",isOn:$m.viewOptions.hideGenerated)
      Toggle("Hide dotfiles and hidden folders",isOn:$m.viewOptions.hideHidden)
      Toggle("Hide logs, lockfiles and compiled artifacts",isOn:$m.viewOptions.hideNoise)
      Text("Documents, Markdown and media come before JSON/config/code at equal name relevance. View filters keep the saved index intact; view:all reveals indexed paths. Explicit extensions or filenames reveal technical artifacts. Generated folders include node_modules, .git, dist, build and target.").font(.caption).foregroundStyle(palette.muted)
      Picker("Quiet result updates",selection:$m.viewOptions.refreshSeconds) {ForEach([1,3,5,10,30],id:\.self) {Text("\($0) s").tag($0)}}
      Picker("Result cache",selection:$m.viewOptions.cacheMiB) {ForEach([16,32,64],id:\.self) {Text("\($0) MB RAM").tag($0)}}
      Text("All matches are available in one continuous list. Nearby results stay in RAM; file icons are created only for visible rows. No load-more buttons or extra disk cache.").font(.caption).foregroundStyle(palette.muted)
      Text("Use (PDFs größer als 10 MB), (Bilder in Downloads) or (Dateien aus den letzten 7 Tagen). Supported clauses become local filters without an AI model. Size/date filters use known cached properties. Inspect the translation in Search details.").font(.caption).foregroundStyle(palette.muted)
      HStack {Button("Favorites only") {m.setQueryOption("favorites","true");m.showOptions=false};Text("⌘P adds or removes the selected file.").font(.caption).foregroundStyle(palette.muted)}
      Divider()
      HStack { Text("Saved searches").fontWeight(.semibold);Spacer();Button("Save current search") {m.saveSearch()} }
      if m.savedSearches.isEmpty { Text("Save a query together with its folder or project. Open it from the bookmark menu beside the search field.").foregroundStyle(palette.muted) }
      ForEach(m.savedSearches) { saved in
        HStack {
          Button {m.openSearch(saved)} label: { VStack(alignment:.leading,spacing:2) {Text(saved.title).lineLimit(1);Text(saved.index).font(.caption).foregroundStyle(palette.muted)} }.buttonStyle(.plain)
          Spacer()
          Button {m.removeSearch(saved)} label: {Image(systemName:"minus.circle")}.buttonStyle(.plain).accessibilityLabel("Remove saved search \(saved.title)")
        }
      }
      Text("Disabling new history entries keeps previous history. Sound rankings retain their acoustic order.").font(.caption).foregroundStyle(palette.muted)
    }
  }
  private var opening: some View {
    VStack(alignment:.leading,spacing:12) {
      Text("Preferred apps for file extensions").fontWeight(.semibold)
      Text("These choices apply only in Find Everything. Other file types use the macOS default. Right-click a result to choose an app just once.").font(.caption).foregroundStyle(palette.muted)
      HStack {
        TextField("Extension, e.g. mp3",text:$openingExtension).textFieldStyle(.roundedBorder).accessibilityLabel("File extension")
        Button("Choose app…") {chooseOpeningApplication()}
      }
      if let openingError {Text(openingError).font(.caption).foregroundStyle(.red)}
      if m.openingPreferences.applications.isEmpty {Text("Using macOS defaults for all files.").foregroundStyle(palette.muted)}
      ForEach(m.openingPreferences.applications.keys.sorted(),id:\.self) {ext in
        HStack {
          Text(".\(ext)").fontWeight(.medium).frame(width:90,alignment:.leading)
          Text(URL(fileURLWithPath:m.openingPreferences.applications[ext] ?? "").deletingPathExtension().lastPathComponent).lineLimit(1)
          Spacer()
          Button("Use system default") {_ = m.openingPreferences.set(application:nil,for:ext)}.accessibilityLabel("Use system default for \(ext)")
        }
      }
    }
  }
  private func chooseOpeningApplication() {
    guard let ext=OpeningPreferences.normalizedExtension(openingExtension) else {openingError="Enter one valid extension, for example mp3.";return}
    let picker=NSOpenPanel();picker.title="Choose an app for .\(ext)";picker.prompt="Choose App"
    picker.canChooseFiles=true;picker.canChooseDirectories=false;picker.allowedContentTypes=[.applicationBundle]
    picker.directoryURL=URL(fileURLWithPath:"/Applications",isDirectory:true)
    guard picker.runModal() == .OK,let app=picker.url else {return}
    guard m.openingPreferences.set(application:app.path,for:ext) else {openingError="The app or extension is invalid.";return}
    openingError=nil;openingExtension=""
  }
  private var indexes: some View {
    VStack(alignment:.leading,spacing:12) {
      Toggle("Keep indexes up to date",isOn:Binding(get:{m.autoUpdate},set:{m.setAutoUpdate($0)}))
      Text(m.liveNote).fontWeight(.medium)
      if let problem=m.liveProblem {
        Text("Some watched folders need attention. Check the update details before relying on complete coverage.").foregroundStyle(palette.muted)
        DisclosureGroup("Update details") { Text(problem).font(.system(size:11,design:.monospaced)).foregroundStyle(palette.muted).textSelection(.enabled) }
      }
      Text("The macOS file journal updates changed paths. Older journal gaps are reported here; they never trigger a hidden full scan.").font(.caption).foregroundStyle(palette.muted)
      Picker("Current index",selection:$m.scope) { ForEach(m.availableScopes) { Text($0.label).tag($0) } }
      Text(m.indexSummaries[m.scope.rawValue] ?? "No index summary").font(.caption).foregroundStyle(palette.muted).textSelection(.enabled)
      HStack {Button("Prepare fast search") {m.showOptions=false;m.prepareLookup()};Button("Cache file size and date") {m.showOptions=false;m.prepareLookup(properties:true)}}.disabled(m.indexing)
      Button("Combine saved indexes") {m.showOptions=false;m.combineLookups()}.disabled(m.indexing)
      Button("Merge saved changes (resume)") {m.showOptions=false;m.compactSavedIndex()}.disabled(m.indexing)
      Text("Combines the saved index and recorded changes. Lost journal history requires an explicit rebuild below.").font(.caption).foregroundStyle(palette.muted)
      Divider()
      Text("Document contents").fontWeight(.semibold)
      Text("content:\"quarterly revenue\" ext:pdf").font(.system(size:12,design:.monospaced)).textSelection(.enabled)
      HStack {
        Button("Index document contents") {m.showOptions=false;m.prepareContents()}
        Button("Index with local OCR") {m.showOptions=false;m.prepareContents(ocr:true)}
        Button("Clear cached document text") {m.showOptions=false;m.prepareContents(clear:true)}
      }.disabled(m.indexing)
      Text("Explicit and local: reads only paths in the selected index. OCR reads scanned PDFs and images, up to 32 pages per file; recognized text can contain errors. Cached text is private but not encrypted. Searches do not read document bodies; run again after edits. Unsupported, oversized and unreadable files stay unknown. Clearing never deletes original files.").font(.caption).foregroundStyle(palette.muted)
      Divider()
      Text("Preparation reuses saved paths without traversing folders. Property indexing checks those paths once and resumes saved progress. Searches reuse the cache.").font(.caption).foregroundStyle(palette.muted)
      HStack { Button("Add folder or project…") {m.showOptions=false;m.indexFolder()};Button("Rebuild current index") {m.showOptions=false;m.rebuild()}.disabled(m.indexing) }
      Button("Rebuild with all accessible files") {m.showOptions=false;m.rebuild(exhaustive:true)}.disabled(m.indexing)
      Text("The inclusive rebuild also searches Library, .local and mounted volumes within the selected roots. Explicit exclusions and macOS permissions still apply. It can take longer and use more disk space.").font(.caption).foregroundStyle(palette.muted)
      Text("Rebuild reads the configured roots again. Use it only when you explicitly want to reconcile an older snapshot.").font(.caption).foregroundStyle(palette.muted)
      DisclosureGroup("Current search details") { Text(m.searchNote.isEmpty ? "No additional details" : m.searchNote).font(.caption).foregroundStyle(palette.muted).textSelection(.enabled) }
    }
  }
  private var audio: some View {
    VStack(alignment:.leading,spacing:12) {
      Text("Local sound search").fontWeight(.semibold)
      Text("audio: duration:<1s\n(kurze düstere Lasersounds)").font(.system(size:13,design:.monospaced)).textSelection(.enabled)
      Text("Duration uses cached file properties. Descriptions rank locally cached audio; results are approximate. Unknown durations are never guessed.").foregroundStyle(palette.muted)
      Button("Read file properties") {m.showOptions=false;m.enrich()}.disabled(m.indexing)
      Button("Recheck unknown audio") {m.showOptions=false;m.enrich(repair:true)}.disabled(m.indexing)
      Button("Analyze matching sounds") {m.showOptions=false;m.analyzeSounds()}.disabled(m.indexing)
      Button("Set up local sound model") {m.showOptions=false;m.analyzeSounds(setup:true)}.disabled(m.indexing)
      Text("Analysis is explicit and bounded. Existing vectors are reused. Model setup downloads pinned files; normal inference stays local.").font(.caption).foregroundStyle(palette.muted)
    }
  }
  private var help: some View {
    VStack(alignment:.leading,spacing:12) {
      Text("Keyboard & access").fontWeight(.semibold)
      Text("⌘, Settings · Space Quick Look · Return Open\n⌘-click / ⇧-click Select multiple · ⇧↑/↓ Extend selection\n⌘↵ Open folder · ⌘C Copy paths · Right-click more actions\n⌘⌥F Search in the selected folder · keeps other filters")
      Button("All keyboard shortcuts") {m.showOptions=false;m.showHelpPanel()}
      Divider()
      Text("Updates preserve the app identifier and signing certificate. macOS manages access; the installer never resets or grants permissions. Switching from the older build may require one renewed approval.").foregroundStyle(palette.muted)
      Button("Open macOS privacy settings") {NSWorkspace.shared.open(URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!)}
      Text("Files outside configured roots, excluded folders and locations without permission are outside the current index. Grant access only to the folders you want to search.").font(.caption).foregroundStyle(palette.muted)
    }
  }
}

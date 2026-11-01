// Privacy-clean product images: production SwiftUI/AppKit views, synthetic files.
// This renderer creates no visible window, runs no bootstrap and captures no screen.
import AppKit
import SwiftUI
import Foundation

private struct PresentationFixture: Decodable {
  let root: String
  let query: String
  let paths: [String]
}

@main struct ReleasePreview {
  @MainActor static func main() async throws {
    let app = NSApplication.shared
    _ = app.setActivationPolicy(.prohibited)
    UserDefaults.standard.setVolatileDomain([
      "scope": "documents", "showDetail": false, "autoUpdate": false,
      "instantSearch.v1": true
    ], forName: UserDefaults.argumentDomain)
    let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
    let fixtureURL = URL(fileURLWithPath: "tests/native/presentation-fixture.json")
    let fixture = try JSONDecoder().decode(PresentationFixture.self, from: Data(contentsOf: fixtureURL))
    precondition(fixture.query == "name:invoice ext:pdf !draft")
    precondition(fixture.paths.count == 6 && fixture.paths.allSatisfy { path in
      let url = URL(fileURLWithPath: path)
      return url.lastPathComponent.localizedCaseInsensitiveContains("invoice")
        && url.pathExtension == "pdf" && !path.localizedCaseInsensitiveContains("draft")
        && !url.deletingLastPathComponent().path.localizedCaseInsensitiveContains("invoice")
    }, "Demo must prove filename matches, not a matching parent folder")
    for appearance in ["light", "dark"] {
      let model = Model()
      model.autoUpdate = false
      model.display = DisplayPreferences()
      model.display.appearance = appearance
      model.display.habitRanking = false
      model.display.showSize = false
      model.display.showModified = false
      model.testRunTool = { args in
        precondition(args == ["indexes", "--json"], "Product images must never run external tools")
        return "[{\"name\":\"documents\",\"paths\":[\"/Demo/Documents\"],\"exists\":true,\"stale\":false}]"
      }
      model.ensureSearchService = { fatalError("Product images must never start a service") }
      await model.loadIndexes()
      model.testSeed(paths: fixture.paths, query: fixture.query, snapshot: "demo", selection: IndexSet(integer: 0), lead: 0, total: fixture.paths.count)
      model.toast = "Synthetic files · filename filters, not document content"
      try render(model, name: "native-\(appearance)", output: output, appearance: appearance)
      if appearance == "light" {
        model.columnFilter = .name
        try render(model, name: "native-filters", output: output, appearance: appearance)
      }
    }
    let missing = Model()
    missing.display = DisplayPreferences()
    missing.display.appearance = "light"
    missing.testRunTool = { _ in "[]" }
    missing.ensureSearchService = { fatalError("Missing index must not start a service") }
    await missing.loadIndexes()
    missing.scope = .documents
    missing.onQueryChange("", force: true)
    precondition(missing.needsIndex && missing.errorMessage != nil)
    try render(missing, name: "native-missing-index", output: output, appearance: "light")
  }

  @MainActor static func render(_ model: Model, name: String, output: URL, appearance: String) throws {
    let host = NSHostingView(rootView: RootView().environmentObject(model))
    let frame = NSRect(x: 0, y: 0, width: 1040, height: 620)
    let window = NSWindow(contentRect: frame, styleMask: [.titled], backing: .buffered, defer: false)
    window.appearance = NSAppearance(named: appearance == "dark" ? .darkAqua : .aqua)
    host.frame = frame
    window.contentView = host
    host.layoutSubtreeIfNeeded()
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.25))
    host.layoutSubtreeIfNeeded()
    host.displayIfNeeded()
    precondition(!window.isVisible && !NSApp.isActive, "Do not take the user's focus")
    guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { fatalError("No native bitmap") }
    host.cacheDisplay(in: host.bounds, to: bitmap)
    guard let png = bitmap.representation(using: .png, properties: [:]), png.count > 4000 else { fatalError("Empty native rendering") }
    try png.write(to: output.appendingPathComponent(name + ".png"), options: .atomic)
    print("Rendered \(name): \(bitmap.pixelsWide)×\(bitmap.pixelsHigh), \(png.count) bytes; synthetic data, no screen capture")
    window.contentView = nil
  }
}

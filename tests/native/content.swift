import AppKit
import Foundation

@main struct NativeContentTests {
  @MainActor static func main() async throws {
    _ = NSApplication.shared.setActivationPolicy(.prohibited)
    let model = Model()
    model.autoUpdate = false
    model.ensureSearchService = {}
    var calls: [[String]] = []
    model.testRunTool = { args in
      calls.append(args)
      precondition(args.first == "content", "Content preparation must not rebuild or traverse the filesystem")
      if args[1] == "clear" { return "{\"cleared\":true}" }
      return calls.count == 1 ? "{\"indexed\":1,\"skipped\":0,\"pending\":1}" : "{\"indexed\":2,\"skipped\":1,\"pending\":0}"
    }
    model.prepareContents()
    precondition(model.indexing)
    for _ in 0..<4000 { await Task.yield(); if !model.indexing { break } }
    model.testCancelSearch()
    precondition(!model.indexing && model.errorMessage == nil && calls.count == 2)
    precondition(calls.allSatisfy { $0.contains("--max-files") && $0.contains("--seconds") })
    model.prepareContents(clear: true)
    for _ in 0..<4000 { await Task.yield(); if !model.indexing { break } }
    model.testCancelSearch()
    precondition(calls.count == 3 && calls[2][1] == "clear" && !model.indexing)
    let retained = SearchQueryOptions.replacingText("name:notes", in: "content:\"quarterly revenue\" old")
    precondition(retained.contains("content:\"quarterly revenue\"") && !retained.contains(" old"))
    model.testRunTool = { _ in throw NSError(domain: "fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Fixture extraction failed"]) }
    model.prepareContents()
    for _ in 0..<4000 { await Task.yield(); if !model.indexing { break } }
    model.testCancelSearch()
    precondition(!model.indexing && model.errorMessage?.contains("Fixture extraction failed") == true)
    print("Document contents: explicit bounded preparation/resume, clear, retained query filter and failure recovery pass; no real files indexed")
  }
}

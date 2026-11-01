enum SelectionTrigger { case keyboard, mouse }
enum ResultInputFocus { case search, results }
enum SelectedQuickAction {case preview,open,folder}

struct ResultNavigation {
  static func canEnterResults(count:Int,queryPending:Bool) -> Bool {count>0 || queryPending}
  static func previewOnSpace(resultFocused:Bool,editingFilter:Bool) -> Bool {
    !editingFilter && resultFocused
  }
  static func shouldSearchWeb(count:Int,searching:Bool,query:String) -> Bool {count==0 && !searching && query.count>1}
  static func arrow(_ direction:Int,current:Int,count:Int,focus:ResultInputFocus) -> Int {
    select(current+(focus == .results ? direction : 0),count:count,trigger:.keyboard).index
  }
  static func isSearchText(_ text:String) -> Bool {
    !text.isEmpty && text.unicodeScalars.allSatisfy{!CharacterSet.controlCharacters.contains($0) && !(0xF700...0xF8FF).contains($0.value)}
  }
  static func select(_ requested: Int, count: Int, trigger: SelectionTrigger) -> (index: Int, scroll: Bool) {
    (max(0, min(requested, count - 1)), trigger == .keyboard && count > 0)
  }
}
import Foundation

/// Index sets stay compact even when a search contains millions of matches.
enum ResultSelection {
  static func bounded(_ rows:IndexSet,count:Int) -> IndexSet {
    rows.intersection(IndexSet(integersIn:0..<max(0,count)))
  }
  static func range(anchor:Int,through:Int,count:Int) -> IndexSet {
    guard count>0 else {return IndexSet()}
    let a=max(0,min(anchor,count-1)),b=max(0,min(through,count-1))
    return IndexSet(integersIn:min(a,b)...max(a,b))
  }
  static func batchRows(_ rows:IndexSet,limit:Int) -> [Int]? {
    guard limit>0,rows.count<=limit else {return nil}
    return Array(rows)
  }
  struct Remapped:Equatable {let rows:IndexSet;let lead:Int}
  /// Remap every selected file by identity; an incomplete or ambiguous mapping is unsafe.
  static func remap(_ rows:IndexSet,lead:Int,cached:(Int)->String?,newPaths:[String],offset:Int) -> Remapped? {
    guard !rows.isEmpty,rows.count<=1000,rows.contains(lead),offset>=0,offset<=Int.max-newPaths.count else {return nil}
    var destinations:[String:Int]=[:],duplicates=Set<String>()
    for (index,path) in newPaths.enumerated() {
      if destinations.updateValue(offset+index,forKey:path) != nil {duplicates.insert(path)}
    }
    var mapped=IndexSet(),leadRow:Int?,seen=Set<String>()
    for row in rows {
      guard let path=cached(row),seen.insert(path).inserted,!duplicates.contains(path),let target=destinations[path] else {return nil}
      mapped.insert(target);if row==lead {leadRow=target}
    }
    guard let leadRow else {return nil}
    return Remapped(rows:mapped,lead:leadRow)
  }
  enum ResolutionError:Error,Equatable {case invalidRow;case missingRow(Int)}
  /// Never return a partial selection or results from a changed search.
  @MainActor static func resolve<Item>(_ rows:[Int],pageSize:Int,cached:(Int)->Item?,
    fetch:(Int) async throws -> [Item],isCurrent:()->Bool) async throws -> [Item] {
    guard pageSize>0 else {throw ResolutionError.invalidRow}
    var pages:[Int:[Item]]=[:],found:[Item]=[]
    for row in rows {
      guard row>=0 else {throw ResolutionError.invalidRow}
      guard isCurrent() else {throw CancellationError()}
      if let item=cached(row) {found.append(item);continue}
      let offset=(row/pageSize)*pageSize
      if pages[offset] == nil {
        pages[offset]=try await fetch(offset)
        guard isCurrent() else {throw CancellationError()}
      }
      guard let page=pages[offset],row-offset<page.count else {throw ResolutionError.missingRow(row)}
      found.append(page[row-offset])
    }
    guard isCurrent() else {throw CancellationError()}
    return found
  }
}

struct SearchRequestGate {
  private var lastKey:String?
  mutating func begin(_ key:String,force:Bool=false) -> Bool {
    guard force || key != lastKey else {return false}
    lastKey=key;return true
  }
}

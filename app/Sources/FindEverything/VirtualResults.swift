import Foundation

struct VirtualResults<Element: Equatable> {
  static var pageSize: Int { 1000 }
  private struct Page { let values: [Element]; let cost: Int }
  private var pages: [Int: Page] = [:]
  private var recent: [Int] = []
  private(set) var bytes = 0
  var budget = 32 * 1024 * 1024 { didSet { trim() } }
  var count: Int { pages.values.reduce(0) { $0 + $1.values.count } }
  var pageCount: Int { pages.count }

  static func offset(for row: Int) -> Int { max(0, row) / pageSize * pageSize }
  static func requests(visible: Range<Int>, total: Int) -> [Int] {
    guard total > 0, !visible.isEmpty else { return [] }
    let first = offset(for: min(total - 1, visible.lowerBound))
    let last = min(first + pageSize, offset(for: min(total - 1, visible.upperBound - 1)))
    var offsets = Array(stride(from: first, through: last, by: pageSize))
    // Visible rows win over speculative work, including during scrollbar drags.
    for distance in 1...5 {
      for candidate in [last + distance * pageSize, first - distance * pageSize]
        where candidate >= 0 && candidate < total { offsets.append(candidate) }
    }
    return offsets
  }
  mutating func value(at row: Int) -> Element? {
    let start = Self.offset(for: row)
    guard row >= 0, let page = pages[start], row - start < page.values.count else { return nil }
    touch(start)
    return page.values[row - start]
  }
  func contains(_ offset: Int) -> Bool { pages[offset] != nil }
  @discardableResult mutating func insert(_ values: [Element], at offset: Int, cost: Int, protecting: Set<Int> = []) -> Bool {
    guard offset >= 0, offset % Self.pageSize == 0, values.count <= Self.pageSize else { return false }
    let changed = pages[offset]?.values != values
    if let old = pages.removeValue(forKey: offset) { bytes -= old.cost }
    recent.removeAll { $0 == offset }
    guard cost >= 0, cost <= budget else { return false }
    while bytes + cost > budget || pages.count >= 32 {
      guard let oldest = recent.first(where:{!protecting.contains($0)}) else {return false}
      recent.removeAll{$0==oldest}; bytes -= pages.removeValue(forKey: oldest)?.cost ?? 0
    }
    pages[offset] = Page(values: values, cost: max(0, cost)); bytes += max(0, cost); touch(offset)
    return changed
  }
  mutating func removeAll() { pages.removeAll(keepingCapacity: true); recent.removeAll(keepingCapacity: true); bytes = 0 }
  private mutating func trim() {
    while bytes > budget, let oldest = recent.first {
      recent.removeFirst(); bytes -= pages.removeValue(forKey: oldest)?.cost ?? 0
    }
  }
  private mutating func touch(_ offset: Int) { recent.removeAll { $0 == offset }; recent.append(offset) }
}

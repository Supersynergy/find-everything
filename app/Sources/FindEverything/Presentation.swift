import Foundation
import SwiftUI

enum SearchQueryOptions {
  static func replacingText(_ text:String,in query:String) -> String {
    let keys:Set<String>=["name","ext","in","type","is","kind","size","dm","modified","sort","content","duration","channels","samplerate","width","height","favorites","fav","view","omit","learn","audio","video","image","case","word"]
    let filters=tokens(query).filter {token in
      token.hasPrefix("!") || token.firstIndex(of:":").map{keys.contains(String(token[..<$0]).lowercased())} == true
    }
    return (filters+[text]).joined(separator:" ")
  }
  static let favoriteAliases:Set<String>=["is:favorite","is:favorites","type:favorite","type:favorites"]
  static func tokens(_ query: String) -> [String] {
    var result: [String] = [], word = "", quoted = false, escaped = false, depth = 0
    for c in query {
      if c == "\"", !escaped { quoted.toggle() }
      if !quoted { if c == "(" { depth += 1 }; if c == ")" { depth = max(0,depth-1) } }
      if c.isWhitespace, !quoted, depth == 0 { if !word.isEmpty { result.append(word);word = "" } }
      else { word.append(c) }
      escaped = c == "\\" && !escaped
    }
    if !word.isEmpty { result.append(word) }
    return result
  }
  static func value(_ key:String,in query:String) -> String? {
    if key=="favorites" {
      return tokens(query).reversed().compactMap {token -> String? in
        let value=token.lowercased()
        if favoriteAliases.contains(value) {return "true"}
        if value.hasPrefix("favorites:") || value.hasPrefix("fav:") {return ["true","yes","1"].contains(String(value.split(separator:":").last ?? "")) ? "true" : "false"}
        return nil
      }.first
    }
    return tokens(query).last(where:{$0.lowercased().hasPrefix(key+":")}).map {String($0.dropFirst(key.count+1))}
  }
  static func setting(_ key:String,_ value:String?,in query:String) -> String {
    let keys=key == "type" ? ["type","is","kind"] : key == "dm" ? ["dm","modified"] : [key]
    var parts=tokens(query).filter{token in
      if favoriteAliases.contains(token.lowercased()) {return key != "favorites"}
      if key=="favorites",token.lowercased().hasPrefix("fav:") {return false}
      return !keys.contains(where:{token.lowercased().hasPrefix($0+":")})
    }
    if let value=value {parts.append(key+":"+value)}
    return parts.joined(separator:" ")
  }
  /// An OR-list of extensions; accept common separators but reject malformed input.
  static func extensionFilter(_ input:String) -> String? {
    let parts=input.components(separatedBy:CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn:",;"))).filter{!$0.isEmpty}
    guard !parts.isEmpty,parts.count<=100 else {return nil}
    var seen=Set<String>(),values:[String]=[]
    for part in parts {
      guard let value=OpeningPreferences.normalizedExtension(part) else {return nil}
      if seen.insert(value).inserted {values.append(value)}
    }
    let joined=values.joined(separator:";")
    return joined.utf8.count<=2048 ? joined : nil
  }
  static func quoted(_ value:String) -> String {
    let encoder=JSONEncoder();encoder.outputFormatting = .withoutEscapingSlashes
    guard let data=try? encoder.encode(value),let text=String(data:data,encoding:.utf8) else {return "\"\""}
    return text
  }
  static func restricting(_ query:String,to folder:String) -> String {
    setting("in",quoted(folder.hasSuffix("/") ? folder : folder+"/"),in:query)
  }
  static func incompleteHint(_ query:String) -> String? {
    var quoted=false,escaped=false,depth=0
    for c in query {
      if c == "\"",!escaped {quoted.toggle()}
      if !quoted {if c == "(" {depth += 1};if c == ")" {depth -= 1}}
      escaped=c == "\\" && !escaped
    }
    if quoted {return "Close the quote to apply this search"}
    return depth>0 ? "Close ) to apply these filters" : nil
  }
  static func unquoted(_ value:String?) -> String {
    guard let value else {return ""}
    guard value.hasPrefix("\""),let data=value.data(using:.utf8),let text=try? JSONDecoder().decode(String.self,from:data) else {return value}
    return text
  }
}

enum ResultColumn: String, CaseIterable, Identifiable {
  case name, path, type, size, modified
  var id:String {rawValue}
  var title:String {rawValue == "modified" ? "Modified" : rawValue.capitalized}
  var filterKeys:[String] {switch self {case .name:return ["name"];case .path:return ["in"];case .type:return ["type","is","kind","ext"];case .size:return ["size"];case .modified:return ["dm","modified"]}}
  var key:String {filterKeys[0]}
  var sorts:[(String,String)] {
    switch self {
    case .name:return [("A → Z","name"),("Z → A","name-desc")]
    case .path:return [("A → Z","path"),("Z → A","path-desc")]
    case .size:return [("Smallest first","small"),("Largest first","big")]
    case .modified:return [("Newest first","new"),("Oldest first","old")]
    case .type:return []
    }
  }
  var presets:[(String,String)] {
    switch self {
    case .type:return [("Audio","audio"),("Documents","doc"),("Code","code"),("Images","image"),("Videos","video"),("Archives","zip"),("Apps","app"),("Hidden","hidden")]
    case .size:return [("Empty · 0 B","=0"),("Under 1 MB","<1m"),("1–10 MB","1m..10m"),("10–100 MB","10m..100m"),("Over 100 MB",">100m"),("Over 1 GB",">1g")]
    case .modified:return [("Last 24 hours","today"),("Last 7 days","week"),("Last 31 days","month"),("Last year","year")]
    default:return []
    }
  }
  func nextSort(in query:String) -> String? {
    guard let first=sorts.first else {return nil}
    return SearchQueryOptions.value("sort",in:query)==first.1 ? sorts.last?.1 : first.1
  }
  func filters(in query:String) -> [String] {SearchQueryOptions.tokens(query).filter{token in
    if self == .type,SearchQueryOptions.favoriteAliases.contains(token.lowercased()) {return false}
    return filterKeys.contains(where:{token.lowercased().hasPrefix($0+":")})
  }}
  func summary(in query:String) -> String {filters(in:query).map{SearchQueryOptions.unquoted($0.split(separator:":",maxSplits:1).last.map(String.init))}.joined(separator:", ")}
  func clearing(in query:String) -> String {filterKeys.reduce(query){SearchQueryOptions.setting($1,nil,in:$0)}}
  func direction(in query:String) -> String? {
    guard let sort=SearchQueryOptions.value("sort",in:query),let index=sorts.firstIndex(where:{$0.1==sort}) else {return nil}
    if self == .size {return index == 0 ? "arrow.up" : "arrow.down"}
    if self == .modified {return index == 0 ? "arrow.down" : "arrow.up"}
    return index == 0 ? "arrow.up" : "arrow.down"
  }
}

struct SearchViewOptions:Codable,Equatable {
  var hideSystem=false
  var hideGenerated=false
  var hideHidden=false
  var hideNoise=false
  var refreshSeconds=5
  var autoplayPreview=false
  var cacheMiB=32
  var keyboardHints=true
  init() {}
  enum CodingKeys:String,CodingKey {case hideSystem,hideGenerated,hideHidden,hideNoise,refreshSeconds,autoplayPreview,cacheMiB,keyboardHints}
  init(from decoder:Decoder) throws {
    self.init();let c=try decoder.container(keyedBy:CodingKeys.self)
    hideSystem=try c.decodeIfPresent(Bool.self,forKey:.hideSystem) ?? hideSystem
    hideGenerated=try c.decodeIfPresent(Bool.self,forKey:.hideGenerated) ?? hideGenerated
    hideHidden=try c.decodeIfPresent(Bool.self,forKey:.hideHidden) ?? hideHidden
    hideNoise=try c.decodeIfPresent(Bool.self,forKey:.hideNoise) ?? hideNoise
    refreshSeconds=try c.decodeIfPresent(Int.self,forKey:.refreshSeconds) ?? refreshSeconds
    autoplayPreview=try c.decodeIfPresent(Bool.self,forKey:.autoplayPreview) ?? autoplayPreview
    cacheMiB=try c.decodeIfPresent(Int.self,forKey:.cacheMiB) ?? cacheMiB
    keyboardHints=try c.decodeIfPresent(Bool.self,forKey:.keyboardHints) ?? keyboardHints
  }
  static let key="searchViewOptions.v1"
  static func load(_ defaults:UserDefaults = .standard) -> Self {
    guard let data=defaults.data(forKey:key),data.count<4096,let value=try? JSONDecoder().decode(Self.self,from:data),[1,3,5,10,30].contains(value.refreshSeconds),[16,32,64].contains(value.cacheMiB) else {return Self()}
    return value
  }
  func persist(_ defaults:UserDefaults = .standard) {
    let encoder=JSONEncoder();encoder.outputFormatting = .sortedKeys
    guard let data=try? encoder.encode(self),defaults.data(forKey:Self.key) != data else {return};defaults.set(data,forKey:Self.key)
  }
  func needsSearchRefresh(comparedTo previous:SearchViewOptions) -> Bool {
    effectiveQuery("") != previous.effectiveQuery("")
  }
  func effectiveQuery(_ query:String,learning:Bool=true) -> String {
    let base:String
    if SearchQueryOptions.value("view",in:query) != nil {base=query}
    else if SearchQueryOptions.value("omit",in:query) != nil {base=query+" view:smart"}
    else {
      let kinds=[hideSystem ? "system" : nil,hideGenerated ? "generated" : nil,hideHidden ? "hidden" : nil,hideNoise ? "noise" : nil].compactMap{$0}
      base=query+" view:smart omit:"+(kinds.isEmpty ? "none" : kinds.joined(separator:";"))
    }
    return learning ? base : base+" learn:off"
  }
}

enum OpenRecents {
  static func updating(_ existing:[String:Double],adding paths:[String],at time:Double,limit:Int=150) -> [String:Double] {
    guard limit>0 else {return [:]}
    var values=existing
    for path in paths {values[path]=time}
    guard values.count>limit else {return values}
    let newest=values.sorted {a,b in a.value == b.value ? a.key < b.key : a.value > b.value}.prefix(limit)
    return Dictionary(uniqueKeysWithValues:newest.map{($0.key,$0.value)})
  }
}

/// App-local overrides only; never change macOS system-wide defaults.
struct OpeningPreferences:Codable,Equatable {
  private(set) var applications:[String:String]=[:]
  static let key="openingPreferences.v1"
  static func normalizedExtension(_ raw:String) -> String? {
    var value=raw.trimmingCharacters(in:.whitespacesAndNewlines).lowercased()
    if value.hasPrefix(".") {value.removeFirst()}
    guard !value.isEmpty,value.utf8.count<=64 else {return nil}
    let parts=value.split(separator:".",omittingEmptySubsequences:false)
    guard parts.allSatisfy({!$0.isEmpty && $0.utf8.allSatisfy{(97...122).contains($0) || (48...57).contains($0) || $0==45 || $0==95}}) else {return nil}
    return value
  }
  private static func validApplication(_ path:String) -> Bool {
    guard path.hasPrefix("/"),!path.contains("\0"),path.utf8.count<=4096 else {return false}
    let url=URL(fileURLWithPath:path)
    return url.pathExtension.lowercased()=="app" && url.standardizedFileURL.path==url.path
  }
  @discardableResult mutating func set(application:String?,for ext:String) -> Bool {
    guard let key=Self.normalizedExtension(ext),application.map(Self.validApplication) ?? true else {return false}
    guard application == nil || applications[key] != nil || applications.count<100 else {return false}
    applications[key]=application;return true
  }
  func application(for ext:String) -> String? {
    guard let key=Self.normalizedExtension(ext) else {return nil}
    return applications[key]
  }
  func application(forFileName name:String) -> String? {
    let file=name.lowercased()
    guard let key=applications.keys.filter({file.hasSuffix("."+$0)}).max(by:{$0.count<$1.count}) else {return nil}
    return applications[key]
  }
  static func load(_ defaults:UserDefaults = .standard) -> Self {
    guard let data=defaults.data(forKey:key),data.count<=64*1024,
      let value=try? JSONDecoder().decode(Self.self,from:data),value.applications.count<=100,
      value.applications.allSatisfy({normalizedExtension($0.key)==$0.key && validApplication($0.value)}) else {return Self()}
    return value
  }
  func persist(_ defaults:UserDefaults = .standard) {
    let encoder=JSONEncoder();encoder.outputFormatting = .sortedKeys
    guard let data=try? encoder.encode(self),data.count<=64*1024,defaults.data(forKey:Self.key) != data else {return}
    defaults.set(data,forKey:Self.key)
  }
}

struct DisplayPreferences: Codable, Equatable {
  var appearance = "system"
  var compact = true
  var showPath = true
  var showType = true
  var showSize = true
  var showModified = true
  var showIcons = true
  var stripedRows = true
  var groupResults = false
  var habitRanking = true
  var rememberHistory = true
  var fontSize = 13.0
  var debounceMs = 0
  static let key = "displayPreferences.v1"
  static func load(_ defaults: UserDefaults = .standard) -> Self {
    guard let data = defaults.data(forKey:key), data.count < 8192,
          let value = try? JSONDecoder().decode(Self.self,from:data),
          ["system","light","dark"].contains(value.appearance),
          (12...17).contains(value.fontSize), [0,60,120,200,350].contains(value.debounceMs) else { return Self() }
    return value
  }
  func persist(_ defaults: UserDefaults = .standard) {
    let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
    guard let data = try? encoder.encode(self), defaults.data(forKey:Self.key) != data else { return }
    defaults.set(data,forKey:Self.key)
  }
  var colorScheme: ColorScheme? { appearance == "dark" ? .dark : appearance == "light" ? .light : nil }
}

struct SavedSearch: Codable, Identifiable, Equatable {
  let id: UUID
  let query: String
  let index: String
  var title: String { query.isEmpty ? "\(index) · All files" : String(query.prefix(64)) }
  static let key = "savedSearches.v1"
  static func load(_ defaults: UserDefaults = .standard) -> [Self] {
    guard let data = defaults.data(forKey:key), data.count <= 262144,
          let values = try? JSONDecoder().decode([Self].self,from:data), values.count <= 32 else { return [] }
    return values.filter { $0.query.count <= 4096 && $0.index.range(of:"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$",options:.regularExpression) != nil }
  }
  static func persist(_ values: [Self], _ defaults: UserDefaults = .standard) {
    let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
    guard values.count <= 32, let data = try? encoder.encode(values), data.count <= 262144,
      defaults.data(forKey:key) != data else { return }
    defaults.set(data,forKey:key)
  }
}

struct SearchPalette {
  let background: String; let panel: String; let ink: String; let secondary: String; let rule: String; let accent: String
  static let light = SearchPalette(background:"FFFFFF",panel:"F1F5F9",ink:"172333",secondary:"475569",rule:"76879C",accent:"1758B8")
  static let dark = SearchPalette(background:"121923",panel:"1C2736",ink:"F2F5FA",secondary:"B8C7DB",rule:"7B8EA7",accent:"3166B7")
  static func forScheme(_ scheme: ColorScheme) -> Self { scheme == .dark ? .dark : .light }
  static func color(_ hex: String) -> Color {
    let value = UInt32(hex,radix:16) ?? 0
    return Color(.sRGB,red:Double((value >> 16)&255)/255,green:Double((value >> 8)&255)/255,blue:Double(value&255)/255,opacity:1)
  }
  var paper: Color { Self.color(background) }
  var surface: Color { Self.color(panel) }
  var text: Color { Self.color(ink) }
  var muted: Color { Self.color(secondary) }
  var border: Color { Self.color(rule) }
  var selection: Color { Self.color(accent) }
}

import SwiftUI

struct ResultSortBar:View {
  @EnvironmentObject var m:Model
  @Environment(\.colorScheme) private var scheme
  var body:some View {
    if m.showSortBar {
      HStack(spacing:8) {
        Text("Sort").fontWeight(.semibold)
        ScrollView(.horizontal,showsIndicators:false) {
          HStack(spacing:6) {
            ForEach(ResultColumn.allCases) {column in
              ForEach(column.sorts,id:\.1) {option in
                Button {m.setQueryOption("sort",option.1)} label: {
                  HStack(spacing:3) {
                    if SearchQueryOptions.value("sort",in:m.query)==option.1 {Image(systemName:"checkmark")}
                    Text(column.title+" · "+option.0)
                  }
                }.buttonStyle(.bordered)
              }
            }
          }
        }
        Button("Default") {m.setQueryOption("sort",nil)}.buttonStyle(.borderless)
        Button {m.showSortBar=false} label:{Image(systemName:"chevron.up")}.buttonStyle(.plain).accessibilityLabel("Collapse sort bar")
      }.font(.system(size:11)).padding(.horizontal,14).padding(.vertical,7).foregroundStyle(SearchPalette.forScheme(scheme).text).background(SearchPalette.forScheme(scheme).surface)
      Divider()
    }
  }
}

struct ResultFiltersView: View {
  @EnvironmentObject var m:Model
  @Environment(\.colorScheme) private var scheme
  private var palette:SearchPalette {.forScheme(scheme)}
  var body:some View {
    if let column=m.columnFilter {
      VStack(alignment:.leading,spacing:8) {
        HStack(spacing:6) {
          ForEach(ResultColumn.allCases) {item in
            Button {m.columnFilter=item} label: {
              Text(item.title).fontWeight(column == item ? .semibold : .regular)
                .padding(.horizontal,8).padding(.vertical,4)
                .background(column == item ? palette.paper : Color.clear).cornerRadius(4)
            }.buttonStyle(.plain).accessibilityLabel("\(item.title) filter row")
          }
          Spacer(minLength:4)
          Button {m.columnFilter=nil} label:{Image(systemName:"chevron.up")}.buttonStyle(.plain).accessibilityLabel("Collapse filter bar")
        }
        ColumnFilterRow(column:column).id(column)
        HStack(spacing:16) {
          Toggle("Favorites only",isOn:Binding(get:{SearchQueryOptions.value("favorites",in:m.query)=="true"},set:{m.setQueryOption("favorites",$0 ? "true" : nil)}))
          Toggle("All indexed files",isOn:Binding(get:{SearchQueryOptions.value("view",in:m.query)=="all"},set:{m.setQueryOption("view",$0 ? "all" : nil)})).help("Override visibility preferences for this query")
          Spacer(minLength:0)
        }.font(.caption)
      }.font(.system(size:12)).foregroundStyle(palette.text).padding(.horizontal,14).padding(.vertical,8)
        .background(palette.surface)
      Divider()
    }
  }
}

struct ColumnFilterRow: View {
  @EnvironmentObject var m:Model
  @Environment(\.colorScheme) private var scheme
  let column:ResultColumn
  @State private var draft=""
  @State private var validationError:String?
  @FocusState private var editing:Bool
  private var palette:SearchPalette {.forScheme(scheme)}
  private var customKey:String {column == .type ? "ext" : column.key}
  private var fieldTitle:String {
    switch column {case .name:return "Filename contains";case .path:return "Folder or path contains";case .type:return "Extensions · mp3, wav, flac";case .size:return "Size · 1m..10m or >=500k";case .modified:return "Changed within · 14d"}
  }
  var body:some View {
    VStack(alignment:.leading,spacing:7) {
      if !column.presets.isEmpty {
        ScrollView(.horizontal,showsIndicators:false) {
          HStack(spacing:6) {
            ForEach(column.presets,id:\.1) {preset in
              choice(preset.0,selected:SearchQueryOptions.value(column.key,in:m.query)==preset.1) {
                if column == .type {m.query=SearchQueryOptions.setting("ext",nil,in:m.query)}
                m.setQueryOption(column.key,preset.1)
                draft=SearchQueryOptions.unquoted(SearchQueryOptions.value(customKey,in:m.query))
              }
            }
          }
        }
      }
      HStack(spacing:8) {
        Text(fieldTitle).font(.caption).frame(width:column == .name || column == .path ? 135 : 164,alignment:.leading)
        TextField("",text:$draft).textFieldStyle(.roundedBorder).focused($editing).accessibilityLabel(fieldTitle).onSubmit {apply()}
        Button("Apply") {apply()}.disabled(draft.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
        if column == .path {Button("Selected folder") {if let item=m.currentItem {m.searchInFolder(item.path);draft=SearchQueryOptions.unquoted(SearchQueryOptions.value("in",in:m.query))}}.disabled(m.currentItem==nil)}
        Button("Clear") {m.query=column.clearing(in:m.query);m.onQueryChange(m.query);draft=""}.disabled(column.filters(in:m.query).isEmpty).accessibilityLabel("Clear \(column.title) filter row")
      }
      if let error=validationError ?? m.errorMessage {Text(error).font(.caption).foregroundStyle(.red).lineLimit(2)}
    }.onAppear {draft=SearchQueryOptions.unquoted(SearchQueryOptions.value(customKey,in:m.query))}
      .onChange(of:SearchQueryOptions.value(customKey,in:m.query)) {value in
        draft=SearchQueryOptions.unquoted(value);validationError=nil
      }
      .onChange(of:editing) {m.editingColumnFilter=$0}
      .onDisappear {m.editingColumnFilter=false}
  }
  private func choice(_ title:String,selected:Bool,action:@escaping()->Void) -> some View {
    Button(action:action) {
      HStack(spacing:4) {if selected {Image(systemName:"checkmark").font(.system(size:9,weight:.bold))};Text(title)}
    }.buttonStyle(.bordered).tint(selected ? palette.selection : nil)
  }
  private func apply() {
    var value=draft.trimmingCharacters(in:.whitespacesAndNewlines)
    guard !value.isEmpty else {return}
    if column == .type {
      guard let extensions=SearchQueryOptions.extensionFilter(value) else {validationError="Use extensions such as mp3, wav or flac";return}
      value=extensions;draft=extensions.replacingOccurrences(of:";",with:", ")
      m.query=ResultColumn.type.clearing(in:m.query)
    }
    validationError=nil
    m.setQueryOption(customKey,column == .name || column == .path ? SearchQueryOptions.quoted(value) : value)
    editing=false
  }
}

import AppKit
import SwiftUI

struct SearchInput: NSViewRepresentable {
  @EnvironmentObject var m:Model
  let color:Color
  func makeCoordinator() -> Coordinator {Coordinator(m)}
  func makeNSView(context:Context) -> NSTextField {
    let field=SearchTextField(string:m.query)
    field.focused = { [weak model=m] in if model?.inputFocus != .search {model?.inputFocus = .search} }
    field.isBordered=false;field.isBezeled=false;field.drawsBackground=false
    field.isEditable=true;field.isSelectable=true;field.focusRingType = .none
    field.font = .systemFont(ofSize:15);field.delegate=context.coordinator
    field.setAccessibilityLabel("Search files and folders")
    field.setContentCompressionResistancePriority(.defaultLow,for:.horizontal)
    m.focusSearchField = { [weak field,weak model=m] selectAll in
      guard let field,let model else {return}
      if field.stringValue != model.query {field.stringValue=model.query}
      field.window?.makeFirstResponder(field)
      if let editor=field.currentEditor() as? NSTextView {
        if editor.string != model.query {editor.string=model.query}
        editor.setSelectedRange(selectAll ? NSRange(location:0,length:editor.string.utf16.count) : NSRange(location:editor.string.utf16.count,length:0))
      }
    }
    return field
  }
  func updateNSView(_ field:NSTextField,context:Context) {
    field.textColor=NSColor(color)
    if field.stringValue != m.query {field.stringValue=m.query}
  }
  @MainActor final class Coordinator:NSObject,NSTextFieldDelegate {
    let model:Model
    init(_ model:Model){self.model=model}
    func controlTextDidBeginEditing(_ notification:Notification) {model.inputFocus = .search}
    func controlTextDidChange(_ notification:Notification) {
      if let field=notification.object as? NSTextField,model.query != field.stringValue {model.query=field.stringValue}
    }
  }
}

private final class SearchTextField:NSTextField {
  var focused:(()->Void)?
  override func becomeFirstResponder() -> Bool {
    let accepted=super.becomeFirstResponder()
    if accepted {
      if let editor=currentEditor() as? NSTextView {
        editor.isAutomaticQuoteSubstitutionEnabled=false;editor.isAutomaticDashSubstitutionEnabled=false
        editor.isAutomaticTextReplacementEnabled=false;editor.isAutomaticSpellingCorrectionEnabled=false
        editor.isContinuousSpellCheckingEnabled=false
      }
      focused?()
    }
    return accepted
  }
}

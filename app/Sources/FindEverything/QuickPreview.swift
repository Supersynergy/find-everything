import AppKit
import Quartz

@MainActor
final class QuickPreviewController:NSObject,NSWindowDelegate {
  private(set) var panel:NSPanel?
  private var view:QLPreviewView?
  private var paths:[String]=[]
  private var index=0
  private var counter:NSTextField?
  private var previousButton:NSButton?,nextButton:NSButton?
  var isVisible:Bool {panel?.isVisible == true}
  func toggle(_ path:String,parent:NSWindow,autoplay:Bool=false) {toggle([path],parent:parent,autoplay:autoplay)}
  func toggle(_ paths:[String],parent:NSWindow,autoplay:Bool=false) {
    guard !paths.isEmpty else {return}
    if isVisible,self.paths==paths {close();parent.makeKeyAndOrderFront(nil);return}
    if panel == nil {
      let panel=NSPanel(contentRect:NSRect(x:0,y:0,width:760,height:560),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
      panel.isReleasedWhenClosed=false;panel.delegate=self;panel.level = .floating
      panel.minSize=NSSize(width:360,height:260)
      let content=NSView(),preview=QLPreviewView(frame:.zero,style:.normal)!
      preview.autostarts=false;preview.shouldCloseWithWindow=false;preview.translatesAutoresizingMaskIntoConstraints=false
      let previous=NSButton(title:"Previous",target:self,action:#selector(previousItem))
      let next=NSButton(title:"Next",target:self,action:#selector(nextItem))
      previous.setAccessibilityLabel("Previous preview");next.setAccessibilityLabel("Next preview")
      let counter=NSTextField(labelWithString:"")
      let controls=NSStackView(views:[previous,counter,next]);controls.orientation = .horizontal;controls.spacing=12;controls.translatesAutoresizingMaskIntoConstraints=false
      content.addSubview(controls);content.addSubview(preview)
      NSLayoutConstraint.activate([
        controls.centerXAnchor.constraint(equalTo:content.centerXAnchor),controls.topAnchor.constraint(equalTo:content.topAnchor,constant:8),
        preview.topAnchor.constraint(equalTo:controls.bottomAnchor,constant:8),preview.leadingAnchor.constraint(equalTo:content.leadingAnchor),
        preview.trailingAnchor.constraint(equalTo:content.trailingAnchor),preview.bottomAnchor.constraint(equalTo:content.bottomAnchor)
      ])
      panel.contentView=content;self.panel=panel;view=preview;self.counter=counter;previousButton=previous;nextButton=next
    }
    self.paths=paths;index=0;view?.autostarts=autoplay
    render();panel?.center();panel?.makeKeyAndOrderFront(nil)
  }
  func update(_ path:String) {
    guard paths != [path] else {return}
    paths=[path];index=0;render()
  }
  @discardableResult func step(_ direction:Int) -> Bool {
    guard paths.count>1 else {return false}
    index=max(0,min(index+direction,paths.count-1));render();return true
  }
  @objc private func previousItem() {_ = step(-1)}
  @objc private func nextItem() {_ = step(1)}
  private func render() {
    guard paths.indices.contains(index) else {return}
    let path=paths[index];view?.previewItem=NSURL(fileURLWithPath:path)
    panel?.title=(path as NSString).lastPathComponent+" · Preview"
    counter?.stringValue=paths.count>1 ? "\(index+1) / \(paths.count)" : "Preview"
    previousButton?.isEnabled=index>0;nextButton?.isEnabled=index+1<paths.count
  }
  func close() {view?.previewItem=nil;paths=[];index=0;panel?.orderOut(nil)}
  func windowWillClose(_ notification:Notification) {close()}
  func shutdown() {close();view?.close();view=nil;panel=nil}
}

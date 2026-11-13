import AppKit
import PDFKit
let output = CommandLine.arguments[1]
func image(_ text:String) -> NSImage {
  let image = NSImage(size:NSSize(width:1200,height:500));image.lockFocus()
  NSColor.white.setFill();NSRect(x:0,y:0,width:1200,height:500).fill()
  (text as NSString).draw(at:NSPoint(x:60,y:220),withAttributes:[.font:NSFont.systemFont(ofSize:54),.foregroundColor:NSColor.black])
  image.unlockFocus();return image
}
let first=image("Polarstern 48271 Invoice"),second=image("Zweiter Beleg 9371")
let bitmap=NSBitmapImageRep(data:first.tiffRepresentation!)!
try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:output+"/scan.png"))
let pdf=PDFDocument();pdf.insert(PDFPage(image:first)!,at:0);pdf.insert(PDFPage(image:second)!,at:1)
guard pdf.write(to:URL(fileURLWithPath:output+"/scan.pdf")) else {fatalError("PDF fixture failed")}

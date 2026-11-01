// Run with swiftc ResultNavigation.swift tests/native/main.swift -o /tmp/fe-navigation-tests.
import Foundation
for count in [0, 1, 300, 11_826_147] {
  for requested in [-10, 0, 1, 150, 999, 11_826_146, 100_000_000] {
    let mouse = ResultNavigation.select(requested, count: count, trigger: .mouse)
    let keyboard = ResultNavigation.select(requested, count: count, trigger: .keyboard)
    precondition(mouse.index == keyboard.index)
    precondition(!mouse.scroll)
    precondition(keyboard.scroll == (count > 0))
    precondition(mouse.index >= 0 && mouse.index <= max(0, count - 1))
  }
}
precondition(ResultNavigation.previewOnSpace(resultFocused:true,editingFilter:false))
precondition(!ResultNavigation.previewOnSpace(resultFocused:false,editingFilter:false))
precondition(!ResultNavigation.previewOnSpace(resultFocused:true,editingFilter:true))
precondition(ResultNavigation.arrow(1,current:0,count:12,focus:.search)==0)
precondition(ResultNavigation.arrow(1,current:0,count:12,focus:.results)==1)
precondition(ResultNavigation.arrow(-1,current:5,count:12,focus:.results)==4)
precondition(ResultNavigation.arrow(1,current:11,count:12,focus:.results)==11)
precondition(!ResultNavigation.canEnterResults(count:0,queryPending:false))
precondition(ResultNavigation.canEnterResults(count:0,queryPending:true))
precondition(ResultNavigation.canEnterResults(count:1,queryPending:false))
for text in ["laser","ä","🪲","中"] {precondition(ResultNavigation.isSearchText(text))}
for text in ["","\n","\u{F700}","\t"] {precondition(!ResultNavigation.isSearchText(text))}
print("Navigation: keyboard scrolls; mouse only selects; full-index row selection passes")
var requests=SearchRequestGate()
precondition(requests.begin("everything\nlaser"))
precondition(!requests.begin("everything\nlaser"))
precondition(requests.begin("everything\nlaser ext:wav"))
precondition(requests.begin("everything\nlaser ext:wav",force:true))
precondition(!requests.begin("everything\nlaser ext:wav"))
precondition(requests.begin("sounds\nlaser ext:wav"))
precondition(requests.begin("everything\nlaser"))
print("Search requests: duplicate suppression, query/scope changes and forced refresh pass")

let range=ResultSelection.range(anchor:2,through:5,count:10)
precondition(Array(range)==[2,3,4,5])
precondition(Array(ResultSelection.range(anchor:5,through:2,count:10))==[2,3,4,5])
precondition(ResultSelection.range(anchor:0,through:10,count:0).isEmpty)
precondition(Array(ResultSelection.bounded(IndexSet([1,5,10]),count:6))==[1,5])
precondition(ResultSelection.batchRows(IndexSet([1,5,10]),limit:3)==[1,5,10])
precondition(ResultSelection.batchRows(IndexSet(integersIn:0..<1_000_000),limit:1000)==nil)
print("Selection: range, bounds and all-or-nothing batch limits pass")

let oldPaths=[0:"/a.wav",1:"/b.mp3",2:"/c.mp3"]
let remapped=ResultSelection.remap(IndexSet([0,2]),lead:2,cached:{oldPaths[$0]},newPaths:["/c.mp3","/b.mp3","/a.wav"],offset:0)
precondition(remapped?.rows==IndexSet([0,2]) && remapped?.lead==0,"Reordered selections follow file identities")
let shifted=ResultSelection.remap(IndexSet([0,2]),lead:0,cached:{oldPaths[$0]},newPaths:["/new","/c.mp3","/a.wav"],offset:1000)
precondition(shifted?.rows==IndexSet([1001,1002]) && shifted?.lead==1002)
precondition(ResultSelection.remap(IndexSet([0,2]),lead:0,cached:{oldPaths[$0]},newPaths:["/a.wav","/new"],offset:0)==nil,"Never remap a partial selection")
precondition(ResultSelection.remap(IndexSet([0,2]),lead:0,cached:{_ in nil},newPaths:["/a.wav","/c.mp3"],offset:0)==nil)
precondition(ResultSelection.remap(IndexSet(integersIn:0..<1001),lead:0,cached:{_ in "/a"},newPaths:["/a"],offset:0)==nil)
precondition(ResultNavigation.shouldSearchWeb(count:0,searching:false,query:"nothing"))
precondition(!ResultNavigation.shouldSearchWeb(count:0,searching:true,query:"nothing"))
precondition(!ResultNavigation.shouldSearchWeb(count:1,searching:false,query:"nothing"))
precondition(!ResultNavigation.shouldSearchWeb(count:0,searching:false,query:"x"))
print("Selection identity remapping and empty-result Enter fallback pass")

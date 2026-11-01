// Execute the production selection resolver against deterministic virtual pages.
import Foundation

@main struct BatchSelectionTests {
  @MainActor static func main() async throws {
    var fetched:[Int]=[]
    let results=try await ResultSelection.resolve([1,2,3,5,6],pageSize:3,cached:{row in row==2 ? "cached-2" : nil},fetch:{offset in
      fetched.append(offset)
      return (offset..<(offset+3)).map{"item-\($0)"}
    },isCurrent:{true})
    precondition(results==["item-1","cached-2","item-3","item-5","item-6"])
    precondition(fetched==[0,3,6],"Fetch each missing page only once")

    do {
      _ = try await ResultSelection.resolve([0,2],pageSize:3,cached:{_ -> Int? in nil},fetch:{_ in [0]},isCurrent:{true})
      fatalError("A missing result must never return a partial selection")
    } catch let error as ResultSelection.ResolutionError {
      precondition(error == .missingRow(2))
    }

    var current=true
    do {
      _ = try await ResultSelection.resolve([1,2],pageSize:3,cached:{_ -> Int? in nil},fetch:{_ in
        await Task.yield();current=false;return [0,1,2]
      },isCurrent:{current})
      fatalError("A changed selection must cancel the whole operation")
    } catch is CancellationError {}

    do {
      _ = try await ResultSelection.resolve([-1],pageSize:3,cached:{_ -> Int? in nil},fetch:{_ in []},isCurrent:{true})
      fatalError("Negative result indexes must be rejected")
    } catch let error as ResultSelection.ResolutionError {
      precondition(error == .invalidRow)
    }
    print("Batch selection: page reuse, ordering, missing rows and stale cancellation pass")
  }
}

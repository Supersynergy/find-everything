// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "FindEverything",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(
      name: "FindEverything",
      path: "Sources/FindEverything"
    )
  ]
)

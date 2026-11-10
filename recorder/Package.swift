// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "PokerRecorder",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "pokerrec", path: "Sources/pokerrec"),
    ]
)

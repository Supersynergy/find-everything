import SwiftUI

/// One compact status rail, not a modal screen; all work controls remain native buttons.
struct IndexingFooter: View {
  @EnvironmentObject var m: Model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let palette: SearchPalette

  var body: some View {
    HStack(spacing: 10) {
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 8) {
          Text(m.indexProgress.map { "\(m.indexingTarget) · \($0.activity)" } ?? m.indexingStatus)
            .font(.system(size: 11, weight: .medium)).foregroundStyle(palette.text)
            .lineLimit(1).truncationMode(.tail)
          Spacer(minLength: 4)
          if let progress=m.indexProgress {
            Text("\(progress.files.formatted()) files").font(.system(size:10)).foregroundStyle(palette.muted).monospacedDigit()
            if let percent=progress.percent {
              Text(percent).font(.system(size:11,weight:.semibold)).monospacedDigit().foregroundStyle(palette.text).frame(minWidth:30,alignment:.trailing)
            }
          }
        }
        Group {
          if let progress=m.indexProgress,let fraction=progress.fraction {
            GeometryReader { geometry in
              ZStack(alignment:.leading) {
                Capsule().fill(palette.border.opacity(0.45))
                Capsule().fill(palette.selection).frame(width:geometry.size.width*fraction)
              }
            }.frame(height:4)
          } else if m.indexProgress?.paused == true || reduceMotion {
            Capsule().fill(palette.border.opacity(0.55)).frame(height:4)
          } else {
            ProgressView().progressViewStyle(.linear).tint(palette.selection)
          }
        }.frame(height:5)
      }
      .frame(maxWidth:.infinity)
      .accessibilityElement(children:.ignore)
      .accessibilityLabel("Indexing progress for \(m.indexingTarget)")
      .accessibilityValue(m.indexProgress?.accessibleValue ?? m.indexingStatus)
      if let progress=m.indexProgress {
        Button {m.toggleIndexingPause()} label: {
          Image(systemName:progress.paused ? "play.fill" : "pause.fill").font(.system(size:11))
        }
        .buttonStyle(.bordered).controlSize(.small).frame(width:28,height:28)
        .disabled(!m.canPauseIndexing || m.indexPausePending)
        .help(progress.paused ? "Continue indexing" : "Pause indexing CPU and disk work")
        .accessibilityLabel(progress.paused ? "Continue indexing" : "Pause indexing")
      }
      Button {m.stopIndexing()} label: {Image(systemName:"stop.fill").font(.system(size:10))}
        .buttonStyle(.bordered).controlSize(.small).frame(width:28,height:28)
        .help(m.indexProgress?.phase == .scan ? "Cancel the scan; keep the previous saved path index" : "Stop preparing search; keep the completed path index and resume preparation later")
        .accessibilityLabel("Cancel indexing")
    }.frame(minWidth:240,maxWidth:.infinity)
  }
}

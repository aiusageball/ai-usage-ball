import SwiftUI

struct ContentView: View {
    @StateObject private var model = UsageModel()

    var body: some View {
        OrbView(config: .claude,
                sessionLeft: model.sessionLeft,
                weeklyLeft: model.weeklyLeft,
                countdown: model.countdown,
                stale: model.stale)
            .onAppear { model.start() }
            .onDisappear { model.stop() }
    }
}

#Preview {
    ContentView()
}

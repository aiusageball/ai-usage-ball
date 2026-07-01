import Foundation
import Combine

/// 原型阶段:直接从局域网的 companion 服务拉数据(GET /state)。
/// 上架版会换成 CloudKit(Mac 推 → 手表读),接口形状保持一致即可。
///
/// /state 返回:{ "session_left": 55, "weekly_left": 42, "reset_in": 14958, "stale": false }
@MainActor
final class UsageModel: ObservableObject {
    @Published var sessionLeft = 0
    @Published var weeklyLeft: Int? = nil
    @Published var countdown = "—:—"
    @Published var stale = true

    // 改成你 Mac 的局域网地址(companion 服务,端口 8765)
    private let url = URL(string: "http://192.168.31.122:8765/state")!

    private var resetIn = 0                 // 服务端给的"距重置秒数"
    private var fetchedAt = Date()          // 上次成功取数时刻(本地推算倒计时)
    private var pollTask: Task<Void, Never>?
    private var tick: Timer?

    func start() {
        // 每秒本地推算倒计时(不依赖网络)
        tick = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.updateCountdown() }
        }
        // 每 15 秒拉一次 /state
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.fetch()
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }

    func stop() { pollTask?.cancel(); tick?.invalidate() }

    private struct State: Decodable {
        let session_left: Int?
        let weekly_left: Int?
        let reset_in: Int?
        let stale: Bool?
    }

    private func fetch() async {
        do {
            var req = URLRequest(url: url)
            req.timeoutInterval = 6
            let (data, _) = try await URLSession.shared.data(for: req)
            let s = try JSONDecoder().decode(State.self, from: data)
            sessionLeft = s.session_left ?? sessionLeft
            weeklyLeft = s.weekly_left
            resetIn = s.reset_in ?? 0
            fetchedAt = Date()
            stale = s.stale ?? false
            updateCountdown()
        } catch {
            // 拉不到 → 标记过期(球变灰),但不清空旧值
            stale = true
        }
    }

    private func updateCountdown() {
        let remaining = max(0, resetIn - Int(Date().timeIntervalSince(fetchedAt)))
        let h = remaining / 3600, m = (remaining % 3600) / 60, s = remaining % 60
        countdown = h > 0 ? String(format: "%d:%02d:%02d", h, m, s)
                          : String(format: "%02d:%02d", m, s)
    }
}

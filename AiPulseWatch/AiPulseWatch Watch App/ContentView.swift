import SwiftUI
import Combine


// Mirror of Mac's formatCountdownHMS
func formatCountdown(_ isoString: String?) -> String {
    guard let iso = isoString, !iso.isEmpty else { return "READY" }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var resetDate = formatter.date(from: iso)
    if resetDate == nil {
        // Try without fractional seconds
        let f2 = ISO8601DateFormatter()
        f2.formatOptions = [.withInternetDateTime]
        resetDate = f2.date(from: iso)
    }
    guard let date = resetDate else { return "READY" }
    let diffMs = date.timeIntervalSinceNow
    if diffMs <= 0 { return "READY" }
    
    let totalSecs = Int(diffMs)
    let secs = totalSecs % 60
    let totalMins = totalSecs / 60
    let mins = totalMins % 60
    let totalHours = totalMins / 60
    
    if totalHours > 99 {
        let days = totalHours / 24
        let remH = totalHours % 24
        return "\(days)d \(String(format: "%02d", remH))h"
    }
    return String(format: "%02d:%02d:%02d", totalHours, mins, secs)
}

struct ContentView: View {
    @EnvironmentObject var networkManager: NetworkManager
    @State private var timers: [String: String] = [:]
    @State private var tab = 0       // 当前可见页(只让它播放液体动画)

    let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()
    
    var body: some View {
        Group {
            if networkManager.connectionStatus != "Connected" {
                VStack(spacing: 8) {
                    ProgressView()
                        .tint(.white)
                    Text(networkManager.connectionStatus)
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundColor(.gray)
                }
            } else if let stats = networkManager.stats {
                TabView(selection: $tab) {
                    // ── Claude ──
                    OrbPage(
                        label: "CLAUDE",
                        primaryLabel: "CLAUDE REMAINING",
                        secondaryLabel: "WEEKLY REMAINING",
                        primaryPct: stats.claude?.remainingPct ?? 100,
                        secondaryPct: stats.claude?.remainingPctSecondary,
                        primaryColor: Color(red: 1.0, green: 0.55, blue: 0.0),      // amber-orange
                        secondaryColor: Color(red: 0.98, green: 0.8, blue: 0.08),   // yellow
                        timer: timers["claude"] ?? "00:00:00",
                        secondaryTimer: timers["claude_secondary"],
                        exhausted: stats.claude?.exhausted ?? false,
                        isActive: tab == 0
                    )
                    .tag(0)

                    // ── Codex ──
                    OrbPage(
                        label: "CODEX",
                        primaryLabel: "CODEX REMAINING",
                        primaryPct: stats.codex?.remainingPct ?? 100,
                        primaryColor: Color(red: 0.94, green: 0.27, blue: 0.27),    // red
                        timer: timers["codex"] ?? "00:00:00",
                        exhausted: stats.codex?.exhausted ?? false,
                        isActive: tab == 1
                    )
                    .tag(1)

                    // ── Antigravity ──
                    OrbPage(
                        label: "ANTIGRAVITY",
                        primaryLabel: "GEMINI REMAINING",
                        secondaryLabel: "CLAUDE REMAINING",
                        primaryPct: stats.antigravity?.remainingPctSecondary ?? 100,
                        secondaryPct: stats.antigravity?.remainingPct,
                        primaryColor: Color(red: 0.02, green: 0.71, blue: 0.83),    // cyan
                        secondaryColor: Color(red: 0.98, green: 0.57, blue: 0.24),  // orange
                        timer: timers["antigravity"] ?? "00:00:00",
                        secondaryTimer: timers["antigravity_claude"],
                        exhausted: stats.antigravity?.exhausted ?? false,
                        isActive: tab == 2
                    )
                    .tag(2)
                }
                .tabViewStyle(PageTabViewStyle())
                .onReceive(timer) { _ in
                    guard let stats = networkManager.stats else { return }
                    timers["claude"] = formatCountdown(stats.claude?.resetsAt)
                    timers["claude_secondary"] = formatCountdown(stats.claude?.resetsAt_secondary)
                    timers["codex"] = formatCountdown(stats.codex?.resetsAt)
                    timers["antigravity"] = formatCountdown(stats.antigravity?.resetsAt_secondary)
                    timers["antigravity_claude"] = formatCountdown(stats.antigravity?.resetsAt)
                }
                .onAppear {
                    // Populate immediately on first appear
                    timers["claude"] = formatCountdown(stats.claude?.resetsAt)
                    timers["claude_secondary"] = formatCountdown(stats.claude?.resetsAt_secondary)
                    timers["codex"] = formatCountdown(stats.codex?.resetsAt)
                    timers["antigravity"] = formatCountdown(stats.antigravity?.resetsAt_secondary)
                    timers["antigravity_claude"] = formatCountdown(stats.antigravity?.resetsAt)
                }
            } else {
                ProgressView("Loading...")
            }
        }
    }
}

struct OrbPage: View {
    var label: String
    var primaryLabel: String
    var secondaryLabel: String? = nil
    var primaryPct: Double
    var secondaryPct: Double? = nil
    var primaryColor: Color
    var secondaryColor: Color? = nil
    var timer: String
    var secondaryTimer: String? = nil
    var exhausted: Bool
    var isActive: Bool = true

    var body: some View {
        ZStack {
            Color.black

            // ── 球:放大铺满,略微上移以视觉居中 ──
            LiquidOrbView(
                label: label,
                primaryPct: primaryPct,
                secondaryPct: secondaryPct,
                primaryColor: primaryColor,
                secondaryColor: secondaryColor,
                timer: timer,
                secondaryTimer: secondaryTimer,
                primaryLabel: primaryLabel,
                secondaryLabel: secondaryLabel,
                exhausted: exhausted,
                isActive: isActive
            )
            .padding(.horizontal, 3)
            .offset(y: -18)
        }
        // ── 左下角:主百分比(单值时居中)──
        .overlay(alignment: secondaryPct == nil ? .bottom : .bottomLeading) {
            cornerPct(primaryPct, exhausted ? .red : primaryColor)
                .padding(.horizontal, 16)
                .padding(.bottom, 4)
        }
        // ── 右下角:次百分比(有就显示)──
        .overlay(alignment: .bottomTrailing) {
            if let sp = secondaryPct {
                cornerPct(sp, secondaryColor ?? primaryColor)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 4)
            }
        }
    }

    // 角落里一个简单的百分比
    @ViewBuilder private func cornerPct(_ v: Double, _ c: Color) -> some View {
        Text("\(Int(max(0, min(100, v))))%")
            .font(.system(size: 15, weight: .heavy, design: .rounded))
            .monospacedDigit()
            .foregroundColor(c)
            .shadow(color: c.opacity(0.6), radius: 4)
    }
}

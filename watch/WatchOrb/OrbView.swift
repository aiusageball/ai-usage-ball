import SwiftUI
import SpriteKit

/// 一个 provider 的配色 / 文案。
struct OrbConfig {
    let provider: String        // "claude" / "codex" / "antigravity" —— 也是纹理 atlas 名
    let name: String            // 显示用大写名
    let color: Color            // 主环色
    let secondaryColor: Color   // 次环色
    let frameCount: Int         // 该 atlas 的帧数(extract-frames.sh 输出的数量)

    static let claude = OrbConfig(
        provider: "claude", name: "CLAUDE",
        color: Color(red: 1.0, green: 0.55, blue: 0.0),
        secondaryColor: Color(red: 0.98, green: 0.80, blue: 0.08),
        frameCount: 49)
    static let codex = OrbConfig(
        provider: "codex", name: "CODEX",
        color: Color(red: 0.94, green: 0.27, blue: 0.27),
        secondaryColor: Color(red: 0.94, green: 0.27, blue: 0.27),
        frameCount: 49)
    static let antigravity = OrbConfig(
        provider: "antigravity", name: "ANTIGRAVITY",
        color: Color(red: 0.02, green: 0.71, blue: 0.83),
        secondaryColor: Color(red: 0.98, green: 0.57, blue: 0.24),
        frameCount: 49)
}

/// 全屏铺满的水晶球:玻璃 + 液体(SpriteKit)+ 双环 + 倒计时。
struct OrbView: View {
    let config: OrbConfig
    var sessionLeft: Int          // 0…100,5 小时剩余
    var weeklyLeft: Int? = nil    // 每周剩余(可空)
    var countdown: String         // "4:09:18"
    var stale: Bool = false

    // 场景持有一次,数据变化时只更新 fillFraction(不重建场景)。
    @State private var scene: LiquidScene? = nil

    private func makeScene(side: CGFloat) -> LiquidScene {
        if let s = scene { return s }
        let s = LiquidScene(provider: config.provider,
                            frameCount: config.frameCount,
                            size: CGSize(width: side, height: side))
        s.fillFraction = CGFloat(sessionLeft) / 100
        DispatchQueue.main.async { self.scene = s }
        return s
    }

    var body: some View {
        GeometryReader { geo in
            let d = min(geo.size.width, geo.size.height)
            ZStack {
                // ── 玻璃球底 ──
                Circle()
                    .fill(RadialGradient(
                        colors: [Color(white: 0.08), Color(white: 0.03)],
                        center: .init(x: 0.5, y: 0.55), startRadius: 2, endRadius: d * 0.6))
                    .overlay(Circle().stroke(Color.white.opacity(0.06), lineWidth: 1))
                    .shadow(color: .black.opacity(0.6), radius: 8)

                // ── 液体(SpriteKit 帧动画)──
                SpriteView(scene: makeScene(side: d * 0.92),
                           options: [.allowsTransparency])
                    .frame(width: d * 0.92, height: d * 0.92)
                    .clipShape(Circle())
                    .opacity(stale ? 0.35 : 1)
                    .grayscale(stale ? 1 : 0)

                // 顶部高光
                Ellipse()
                    .fill(RadialGradient(colors: [.white.opacity(0.35), .clear],
                                         center: .center, startRadius: 0, endRadius: d * 0.18))
                    .frame(width: d * 0.34, height: d * 0.18)
                    .offset(y: -d * 0.28)
                    .blur(radius: 2)

                rings(d: d)
                labels(d: d)
            }
            .frame(width: d, height: d)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onChange(of: sessionLeft) { _, new in
                scene?.fillFraction = CGFloat(new) / 100
            }
        }
        .ignoresSafeArea()
        .background(Color.black)
    }

    // ── 双环 ──
    @ViewBuilder private func rings(d: CGFloat) -> some View {
        let lw = d * 0.045
        ZStack {
            // 外装饰环
            Circle().stroke(config.color.opacity(0.30), lineWidth: 1).padding(d * 0.02)
            // 主环 track + value(5h)
            Circle().stroke(config.color.opacity(0.20), lineWidth: lw).padding(d * 0.10)
            Circle()
                .trim(from: 0, to: CGFloat(max(0, min(100, sessionLeft))) / 100)
                .stroke(config.color, style: StrokeStyle(lineWidth: lw, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .padding(d * 0.10)
                .shadow(color: config.color.opacity(0.7), radius: 4)
            // 次环(weekly)
            if let w = weeklyLeft {
                let lw2 = d * 0.03
                Circle().stroke(config.secondaryColor.opacity(0.15), lineWidth: lw2).padding(d * 0.20)
                Circle()
                    .trim(from: 0, to: CGFloat(max(0, min(100, w))) / 100)
                    .stroke(config.secondaryColor.opacity(0.75),
                            style: StrokeStyle(lineWidth: lw2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .padding(d * 0.20)
            }
        }
    }

    // ── 中心文字 ──
    @ViewBuilder private func labels(d: CGFloat) -> some View {
        VStack(spacing: 2) {
            Text(config.name)
                .font(.system(size: d * 0.07, weight: .bold))
                .tracking(1.5)
                .foregroundStyle(config.color.opacity(0.9))
            Text(stale ? "—:—" : countdown)
                .font(.system(size: d * 0.19, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
                .monospacedDigit()
                .shadow(color: config.color.opacity(0.8), radius: 8)
            if stale {
                Text("⟳ 数据过期").font(.system(size: d * 0.06)).foregroundStyle(.orange)
            } else {
                Text("\(max(0, min(100, sessionLeft)))% left")
                    .font(.system(size: d * 0.06)).foregroundStyle(.white.opacity(0.6))
            }
        }
    }
}

#Preview {
    OrbView(config: .claude, sessionLeft: 55, weeklyLeft: 42, countdown: "4:09:18")
}

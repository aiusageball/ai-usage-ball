import SwiftUI

// MARK: - Progress Ring Shape
struct ArcRing: Shape {
    var progress: Double
    var startAngle: Double = -90

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.addArc(
            center: CGPoint(x: rect.midX, y: rect.midY),
            radius: min(rect.width, rect.height) / 2,
            startAngle: .degrees(startAngle),
            endAngle: .degrees(startAngle + 360 * progress),
            clockwise: false
        )
        return path
    }
}

// MARK: - Real-video Liquid (帧序列,纯 SwiftUI)
// 帧来自桌面同一段视频(逐像素一致),放在 Assets.xcassets 里:
//   claude_000…claude_048 / codex_000… / antigravity_000…
// 用 TimelineView 逐帧循环;boomerang(正放→倒放)= 无缝。
// `.screen` 混合让帧里的黑色背景消失,只留发光液体浮在黑玻璃上。
// 仅当前可见的球播放(isActive),否则静止一帧 —— 否则主线程被占满、倒计时卡顿。
// (watchOS 不支持 VideoPlayer/SpriteView 的相关初始化器,所以用纯 SwiftUI Image 帧。)
struct LiquidSprite: View {
    var atlasName: String      // "claude" / "codex" / "antigravity"
    var pct: Double            // 0–100 remaining
    var isActive: Bool = true

    private let frameCount = 49
    private let fps: Double = 12

    var body: some View {
        let scale   = max(0.01, pct / 100.0)   // 复刻桌面:blob 随剩余% 缩放
        let opacity = min(1.0,  pct / 8.0)      // 复刻桌面:接近 0 时淡出
        Group {
            if isActive {
                // 用 .periodic 按 12fps 刷(不是 .animation 的 60fps),给主线程留出余量,
                // 否则每秒一次的倒计时定时器会被饿死、一卡一卡。
                TimelineView(.periodic(from: .now, by: 1.0 / fps)) { ctx in
                    frame(at: ctx.date)
                }
            } else {
                frame(at: Date(timeIntervalSinceReferenceDate: 0))   // 切走的球:静止一帧
            }
        }
        .scaleEffect(scale)
        .opacity(opacity)
        .blendMode(.screen)             // 黑底消失,只留液体(同 Mac 的 mix-blend-mode:screen)
    }

    private func frame(at date: Date) -> some View {
        let period = max(1, (frameCount - 1) * 2)        // boomerang 周期
        let phase = Int(date.timeIntervalSinceReferenceDate * fps) % period
        let idx = phase < frameCount ? phase : period - phase
        return Image("\(atlasName)_\(String(format: "%03d", idx))")
            .resizable()
            .scaledToFill()
    }
}

// MARK: - Main Orb View
struct LiquidOrbView: View {
    var label: String
    var primaryPct: Double
    var secondaryPct: Double?
    var primaryColor: Color
    var secondaryColor: Color?
    var timer: String
    var secondaryTimer: String?
    var primaryLabel: String
    var secondaryLabel: String?
    var exhausted: Bool
    var isActive: Bool = true       // 是否为当前可见页(决定液体是否播放动画)

    @State private var animatedPrimary:   Double = 0
    @State private var animatedSecondary: Double = 0
    @State private var breathe: Bool = false

    var body: some View {
        let isCritical   = primaryPct < 10 || (secondaryPct ?? 100) < 10
        let ringColor    = exhausted ? Color.red : (isCritical ? Color.orange : primaryColor)
        let ringColorSec = exhausted ? Color.red : (secondaryColor ?? primaryColor)

        ZStack {
            // 1. Black glass sphere base (.orb-glass background + box-shadow)
            Circle()
                .fill(Color.black)
                .overlay(Circle().stroke(Color.white.opacity(0.15), lineWidth: 1))

            // 2. Real-video liquid (帧序列) — screen-blended, clipped to circle
            LiquidSprite(atlasName: label.lowercased(), pct: animatedPrimary, isActive: isActive)
                .clipShape(Circle().inset(by: 1))

            // 3. Inner depth shadow (matches .orb-inner-shadow: inset 0 -50px 80px black)
            Circle()
                .fill(
                    RadialGradient(
                        gradient: Gradient(colors: [.clear, .black.opacity(0.9)]),
                        center: UnitPoint(x: 0.5, y: 1.2),
                        startRadius: 0,
                        endRadius: 100
                    )
                )
                .allowsHitTesting(false)

            // 4. Outer decorative thin ring
            Circle()
                .stroke(ringColor.opacity(0.35), lineWidth: 1)
                .padding(5)

            // 5. Primary progress track
            Circle()
                .stroke(ringColor.opacity(0.22), lineWidth: 7)
                .padding(11)

            // 6. Primary progress ring + glow
            ArcRing(progress: max(0, min(1, animatedPrimary / 100.0)))
                .stroke(ringColor, style: StrokeStyle(lineWidth: 7, lineCap: .round))
                .padding(11)
                .shadow(color: ringColor.opacity(0.9), radius: 5)

            // 7. Inner ring (secondary, e.g. Claude weekly / Antigravity claude)
            if secondaryPct != nil {
                Circle()
                    .stroke(ringColorSec.opacity(0.22), lineWidth: 5)
                    .padding(23)

                ArcRing(progress: max(0, min(1, animatedSecondary / 100.0)))
                    .stroke(ringColorSec.opacity(0.85),
                            style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .padding(23)
                    .shadow(color: ringColorSec.opacity(0.75), radius: 3)
            }

            // 8. Timer text (centered, like Mac .orb-timer-wrapper)
            VStack(spacing: 2) {
                Text(timer)
                    .font(.system(size: 17, weight: .bold, design: .monospaced))
                    .foregroundColor(ringColor)
                    .shadow(color: ringColor, radius: 8)
                    .minimumScaleFactor(0.4)
                    .lineLimit(1)

                if let st = secondaryTimer {
                    Text(st)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundColor(ringColorSec.opacity(0.9))
                        .shadow(color: ringColorSec.opacity(0.8), radius: 4)
                        .minimumScaleFactor(0.4)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 22)

            // 9. Glass specular (.orb-specular: top 4%, left 12%, w 76%, h 45%)
            VStack {
                Ellipse()
                    .fill(
                        LinearGradient(
                            gradient: Gradient(colors: [Color.white.opacity(0.42), .clear]),
                            startPoint: .top, endPoint: .bottom
                        )
                    )
                    .frame(height: 55)
                    .padding(.horizontal, 18)
                    .padding(.top, 4)
                Spacer()
            }
        }
        // Breathing animation (.orb-glass-breather: animation: orb-breathe 2s infinite)
        .scaleEffect(breathe ? 1.018 : 0.982)
        .onAppear {
            withAnimation(.easeInOut(duration: 2).repeatForever(autoreverses: true)) {
                breathe = true
            }
            withAnimation(.easeOut(duration: 1.4)) {
                animatedPrimary   = primaryPct
                animatedSecondary = secondaryPct ?? 0
            }
        }
        .onChange(of: primaryPct)        { _, v in withAnimation(.easeInOut(duration: 0.6)) { animatedPrimary = v } }
        .onChange(of: secondaryPct ?? 0) { _, v in withAnimation(.easeInOut(duration: 0.6)) { animatedSecondary = v } }
    }
}

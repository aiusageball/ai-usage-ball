import SpriteKit

/// 播放液体帧序列的 SpriteKit 场景。
/// - 帧来自一个 SKTextureAtlas(名字 = provider,如 "claude"),里面是
///   liquid_000.png … liquid_0NN.png(由 scripts/extract-frames.sh 导出)。
/// - boomerang:正放→倒放,任意片段都能完美无缝循环,且只需存一半帧。
/// - 圆形遮罩 + 按剩余百分比缩放,复刻桌面版"液位随用量变化"的观感。
final class LiquidScene: SKScene {

    private let provider: String
    private let frameCount: Int
    private let fps: Double

    private var sprite: SKSpriteNode?

    /// 剩余比例 0…1(= 1 - 已用)。越满,液体越大。
    var fillFraction: CGFloat = 0.5 {
        didSet { applyFill() }
    }

    init(provider: String, frameCount: Int, fps: Double = 12, size: CGSize) {
        self.provider = provider
        self.frameCount = frameCount
        self.fps = fps
        super.init(size: size)
        scaleMode = .aspectFill
        backgroundColor = .clear          // 让底下的 SwiftUI 玻璃透出来
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    override func didMove(to view: SKView) {
        guard sprite == nil else { return }   // 只构建一次

        // ── 圆形遮罩,只露出中间圆形区域 ──
        let mask = SKShapeNode(circleOfRadius: size.width / 2)
        mask.fillColor = .white
        mask.strokeColor = .clear
        let crop = SKCropNode()
        crop.maskNode = mask
        crop.position = CGPoint(x: size.width / 2, y: size.height / 2)
        addChild(crop)

        // ── 载入帧 + boomerang ──
        let atlas = SKTextureAtlas(named: provider)
        let forward: [SKTexture] = (0..<frameCount).map {
            atlas.textureNamed(String(format: "liquid_%03d", $0))
        }
        forward.forEach { $0.filteringMode = .linear }
        // 正放 + 倒放(去掉首尾重复帧),拼成无缝循环
        let boomerang = forward + Array(forward.dropFirst().dropLast().reversed())

        let node = SKSpriteNode(texture: forward.first)
        node.size = size
        crop.addChild(node)
        node.run(.repeatForever(
            .animate(with: boomerang, timePerFrame: 1.0 / fps, resize: false, restore: true)
        ))
        sprite = node
        applyFill()
    }

    private func applyFill() {
        // 复刻桌面:blob 随剩余% 缩放;接近 0 时淡出
        let f = max(0.02, min(1, fillFraction))
        sprite?.setScale(f)
        sprite?.alpha = min(1, fillFraction / 0.08)
    }
}

# AI Pulse — Apple Watch 球(原型)

把桌面版的液体水晶球搬到 Apple Watch。液体 = 桌面同一段视频导出的帧序列,用
SpriteKit 播,**逐像素一致**;只在打开 App 时流动(表盘小组件上是静帧,系统限制)。

```
liquid-loop.mp4 ──extract-frames.sh──▶ frames/<provider>/*.png
                                              │ (拖进 Xcode 当 .atlas)
                              SpriteKit 纹理动画(boomerang 无缝循环)
Mac companion :8765 /state ──每15s──▶ UsageModel ──▶ OrbView(环+玻璃+液体+倒计时)
```

## 文件
| 文件 | 作用 |
|---|---|
| `scripts/extract-frames.sh` | 视频 → 帧序列(中心裁方、缩放、降帧、按家配色) |
| `frames/claude/` | 已导出的 49 帧(200×200, 12fps) |
| `WatchOrb/LiquidScene.swift` | SpriteKit 场景:帧动画 + 圆形遮罩 + 按剩余%缩放 |
| `WatchOrb/OrbView.swift` | SwiftUI:玻璃 + 双环 + 液体 + 倒计时(全屏铺满) |
| `WatchOrb/UsageModel.swift` | 拉 `/state` 数据 + 本地每秒倒计时 |
| `WatchOrb/ContentView.swift` | 把上面拼起来 |

## 在 Xcode 里装配(一次性)
1. **新建项目** → watchOS → App(SwiftUI、含 Watch App)。
2. 把 `WatchOrb/*.swift` 四个文件拖进 Watch App target。
3. **加帧资源(关键)**:在 Finder 里把 `frames/claude` 这个**文件夹改名为 `claude.atlas`**,
   整个拖进 Xcode 的 Assets 旁边(确保 target membership 勾上)。Xcode 会把
   `*.atlas` 文件夹编译成 `SKTextureAtlas(named: "claude")`。
   - 三家就准备 `claude.atlas` / `codex.atlas` / `antigravity.atlas`(先跑
     `./extract-frames.sh codex` 和 `antigravity` 生成另两套帧)。
4. **允许局域网明文 HTTP**(原型用,连 `http://…:8765`):Info.plist 加
   `App Transport Security Settings → Allow Arbitrary Loads = YES`(上架版走 HTTPS/CloudKit 后删掉)。
5. 把 `UsageModel.url` 里的 IP 改成你 Mac 的局域网地址。
6. 选 Apple Watch 模拟器或真机 Run。Preview 里用写死的 55% 也能直接看视觉。

## 调参(在 `extract-frames.sh`)
- `SIZE`(默认 200)、`FPS`(12)、`DUR`(4 秒 → boomerang ≈8 秒循环)。
- 内存吃紧就调小 SIZE 或 DUR;要更顺滑就升 FPS。
- 改完记得同步 `OrbConfig.frameCount`(= 实际帧数)。

## 之后:换成 CloudKit(上架版)
- Mac 后端把 `{session_left, weekly_left, reset_in, stale}` 写进用户 CloudKit
  公共库(server-to-server REST,带随机 token 当 key)。
- `UsageModel` 把"拉 /state"换成"读 CloudKit 那条记录",其余 UI 不动。
- 需要 Apple 开发者账号($99/年)建容器、签名、上架。

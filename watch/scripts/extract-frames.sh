#!/usr/bin/env bash
#
# extract-frames.sh — 把桌面版的液体视频 liquid-loop.mp4 导成 Apple Watch 用的
# 帧序列(SpriteKit 纹理动画)。中心裁成正方形、缩小、降帧,按 provider 配色。
#
# 用法:
#   ./extract-frames.sh claude        # 默认参数,导 Claude(橙)
#   ./extract-frames.sh codex         # 红
#   ./extract-frames.sh antigravity   # 青
#   SIZE=240 FPS=12 DUR=4 ./extract-frames.sh claude   # 自定义
#
# 参数(环境变量可覆盖):
#   SIZE  输出方形边长(px),默认 200
#   FPS   抽帧帧率,默认 12
#   DUR   取视频前几秒,默认 4(配合播放端 boomerang = 约 8 秒无缝循环)
#   START 起始秒,默认 0
#
# 输出: watch/frames/<provider>/liquid_000.png ...(从 0 起,零填充 3 位)
#
set -euo pipefail

PROVIDER="${1:-claude}"
SIZE="${SIZE:-200}"
FPS="${FPS:-12}"
DUR="${DUR:-4}"
START="${START:-0}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/../liquid-loop.mp4"          # watch/ 的上一级就是 Antigravity/
OUT="$ROOT/frames/$PROVIDER"

if [[ ! -f "$SRC" ]]; then
  echo "✗ 找不到源视频: $SRC"; exit 1
fi

# 各家配色:用 ffmpeg 的 hue 滤镜旋转色相,对应桌面端的 CSS videoFilter
case "$PROVIDER" in
  claude)       HUE="";                                   ;;  # 基底就是橙,不改
  codex)        HUE=",hue=h=320:s=2.0";                   ;;  # 红
  antigravity)  HUE=",hue=h=185:s=1.8";                   ;;  # 青
  *) echo "未知 provider: $PROVIDER (claude|codex|antigravity)"; exit 1 ;;
esac

rm -rf "$OUT"; mkdir -p "$OUT"

# 中心裁正方形(720x720) -> 缩放 -> 降帧 -> (配色)
VF="crop=720:720:(in_w-720)/2:0,scale=${SIZE}:${SIZE},fps=${FPS}${HUE}"

echo "导帧: $PROVIDER  size=${SIZE} fps=${FPS} dur=${DUR}s  -> $OUT"
ffmpeg -y -loglevel error -ss "$START" -t "$DUR" -i "$SRC" \
  -vf "$VF" -start_number 0 "$OUT/liquid_%03d.png"

N=$(ls "$OUT"/liquid_*.png | wc -l | tr -d ' ')
BYTES=$(du -sh "$OUT" | cut -f1)
echo "✓ 完成: $N 帧, 共 $BYTES (boomerang 播放 ≈ $((N*2-2)) 帧无缝循环)"

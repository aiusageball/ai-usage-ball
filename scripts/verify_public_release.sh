#!/bin/bash

set -euo pipefail

DOWNLOAD_URL="https://github.com/aiusageball/ai-usage-ball/releases/latest/download/AI-Usage-Ball.dmg"

echo "Checking $DOWNLOAD_URL"
curl --fail --silent --show-error --location \
  --range 0-0 \
  --output /dev/null \
  "$DOWNLOAD_URL"
echo "Public DMG download is available."

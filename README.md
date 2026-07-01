# AI Usage Ball

A living "crystal ball" for your macOS desktop that shows how much of your AI
coding-tool quota — Claude, Codex / ChatGPT, and Antigravity — you have left,
as animated liquid gauges. Session limits, weekly limits, and reset
countdowns, at a glance.

**Get the signed, notarized build:** [aiusageball.com](https://aiusageball.com)
(one-time purchase, 30-day free trial, no subscription).

This repository is the full source, published so anyone can audit exactly
what the app reads from your machine and how — see [License](#license) for
what you can and can't do with it.

## What's in here

| Path | What it is |
|---|---|
| `dashboard/` | The desktop app — Tauri v2 (Rust) + React frontend. Main window, desktop widgets, the liquid-orb visualization. |
| `server/` | Python (FastAPI) backend the app talks to on `127.0.0.1:8000`. Reads local usage data (Claude via browser session cookie / CLI credentials, Codex via `~/.codex/auth.json`, Antigravity via local process detection) and streams it to the frontend over SSE. |
| `AiPulseWatch/` | watchOS companion (SwiftUI), work in progress. |
| `landing/` | Source for the [aiusageball.com](https://aiusageball.com) marketing site (static HTML, no build step). |

## How it reads your usage

Everything is read **locally**, from sessions/credentials already on your
machine — nothing is proxied through a server we run. The backend's polling
logic lives in `server/server.py`; that file is the ground truth for exactly
what's read and from where.

## Running it locally

**Backend:**
```bash
cd server
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python server.py   # serves http://127.0.0.1:8000
```

**Desktop app:**
```bash
cd dashboard
npm install
npm run tauri:dev
```

Building a distributable `.app`/`.dmg` requires your own Apple Developer
Program signing identity (see `dashboard/src-tauri/tauri.conf.json` →
`bundle.macOS.signingIdentity`) — unsigned local builds work fine for
development.

## License

Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE): you're
free to read, audit, modify, and build the source for personal / noncommercial
use. Commercial use (selling it, bundling it, offering it as a paid service,
etc.) isn't permitted under this license — get in touch if you want that.

The official signed, notarized build at [aiusageball.com](https://aiusageball.com)
supports continued development.

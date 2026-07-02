# Launch Checklist

Promotion should happen in layers: first make the GitHub and website surfaces
convert well, then submit to curated directories, then do timed community
launches.

## Completed

- GitHub homepage URL set to `https://aiusageball.com`.
- GitHub topics include `ai-coding`, `developer-tools`, `source-available`,
  `fastapi`, and `react`.
- First Awesome List PR submitted:
  https://github.com/tauri-apps/awesome-tauri/pull/775
- Second Awesome List PR submitted:
  https://github.com/iCHAIT/awesome-macOS/pull/901

## GitHub Release

Create an initial release once the signed DMG is ready to attach or link.

Suggested tag:

```text
v0.1.0
```

Suggested title:

```text
AI Usage Ball 0.1.0
```

Suggested release notes:

```md
Initial public release of AI Usage Ball.

AI Usage Ball is a macOS desktop app that keeps Claude, Codex / ChatGPT, and
Antigravity usage limits visible as live liquid gauges.

Highlights:

- Live quota gauges for Claude, Codex / ChatGPT, and Antigravity.
- Session and weekly reset countdowns where available.
- Local FastAPI backend that reads usage state from the user's Mac.
- Tauri v2 desktop UI with desktop/widget-style gauges.
- Source available for auditability and noncommercial self-builds.

Signed build:
https://aiusageball.com
```

## Show HN

Suggested title:

```text
Show HN: AI Usage Ball - live quota gauges for Claude, Codex and Antigravity
```

Suggested opening:

```md
I built a small macOS app because I kept losing track of AI coding-tool limits
until a session suddenly ran out.

AI Usage Ball keeps Claude, Codex / ChatGPT, and Antigravity usage visible as
live liquid gauges with reset countdowns. The usage readers run locally on your
Mac; the source is available so people can audit what it reads and from where.

It is a paid signed build with a 30-day trial, and the repo is available for
auditability and noncommercial self-builds.
```

## Product Hunt

Prepare but do not launch until there is at least one accepted directory listing
or community discussion to point to.

Assets to prepare:

- Product tagline: `Live quota gauges for AI coding tools.`
- Thumbnail: one clear orb or three-orb dashboard crop.
- Gallery images: desktop app, menu/widget view, privacy/local-data explanation.
- First comment: founder story, privacy model, who it is for, and what feedback
  would be useful.

## Reddit

Use community-specific posts, not a generic announcement.

Candidate communities:

- `r/macapps`
- `r/ClaudeAI`
- `r/ChatGPTCoding`

Angle:

```md
I made a macOS menu bar app to keep Claude / Codex / Antigravity usage limits
visible because I kept discovering limits only after hitting them.
```

Avoid:

- Posting identical copy across communities.
- Leading with price.
- Calling it open source while it uses the PolyForm Noncommercial License.

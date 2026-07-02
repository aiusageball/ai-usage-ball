# Awesome List Outreach

This document collects the first promotion targets and ready-to-use submission
copy for AI Usage Ball.

## Positioning

AI Usage Ball is a source-available macOS desktop app that keeps AI coding-tool
usage limits visible. It shows Claude, Codex / ChatGPT, and Antigravity quota
state as live liquid gauges, with reset countdowns, using local-only usage
readers and a Tauri desktop UI.

Use "source-available" instead of "open source" in submissions because the repo
uses the PolyForm Noncommercial License rather than an OSI-approved license.

## Primary Submission Line

```md
- [AI Usage Ball](https://github.com/aiusageball/ai-usage-ball) - Source-available macOS desktop app that shows remaining Claude, Codex / ChatGPT, and Antigravity usage limits as live liquid gauges. Built with Tauri, React, Rust, and a local FastAPI backend.
```

## Website-First Variant

```md
- [AI Usage Ball](https://aiusageball.com) - macOS desktop app for keeping Claude, Codex / ChatGPT, and Antigravity usage limits visible at a glance, with source available on GitHub.
```

## Target Lists

| Priority | Repository | Suggested section | Why it fits |
|---|---|---|---|
| 1 | `tauri-apps/awesome-tauri` | Applications / Information | The desktop app is built with Tauri v2 and works as an AI usage/status monitor, matching nearby entries such as hardware monitors and menubar information apps. |
| 2 | `iCHAIT/awesome-macOS` | Applications / Utilities | It is a macOS status utility with a signed app build and 30-day free trial. |
| 3 | `jaywcjlove/awesome-mac` | Developer Tools or Utilities | Large macOS software list; worth submitting after the project page is polished. |
| 4 | `filipecalegario/awesome-vibe-coding` | Tools or Resources | The audience is heavy AI coding-tool users, even though the app is a companion utility rather than an AI coding tool. |

## Suggested PR Body

```md
Hi, thanks for maintaining this list.

This PR adds AI Usage Ball, a source-available macOS desktop app for keeping AI
coding-tool usage limits visible. It currently tracks Claude, Codex / ChatGPT,
and Antigravity quota state through local readers and displays the remaining
limits as live liquid gauges.

I placed it under <SECTION> because it is primarily an information/status
monitor for developers using AI coding tools. The app is built with Tauri v2,
React, Rust, and a local FastAPI backend.
```

## `tauri-apps/awesome-tauri` First PR

Status: submitted as https://github.com/tauri-apps/awesome-tauri/pull/775

Target branch: `dev`

Recommended section: `Applications` -> `Information`

Add this line alphabetically near the top of the `Information` section, before
`Cores`:

```md
- [AI Usage Ball](https://github.com/aiusageball/ai-usage-ball) ![paid] ![v2] - Source-available macOS desktop app that shows remaining Claude, Codex / ChatGPT, and Antigravity usage limits as live liquid gauges.
```

Suggested PR title:

```text
Add AI Usage Ball
```

Suggested PR body:

```md
Hi, thanks for maintaining this list.

This PR adds AI Usage Ball, a source-available macOS desktop app for keeping AI
coding-tool usage limits visible. It currently tracks Claude, Codex / ChatGPT,
and Antigravity quota state through local readers and displays the remaining
limits as live liquid gauges.

I placed it under Applications / Information because it works as a status
monitor for developers using AI coding tools. The app is built with Tauri v2,
React, Rust, and a local FastAPI backend.
```

## `iCHAIT/awesome-macOS` Second PR

Status: submitted as https://github.com/iCHAIT/awesome-macOS/pull/901

Target branch: `master`

Recommended section: `Applications` -> `Utilities`

Submitted line:

```md
- [AI Usage Ball](https://aiusageball.com) - Menu bar gauges for Claude, Codex, and Antigravity usage limits.
```

Notes:

- Do not add the OSS icon unless the license changes to an OSI-approved license.
- Do not add the Freeware icon because the signed app is commercial after the trial.
- Explain in the PR body that this is not an AI prompt wrapper; it is a local usage/status monitor.

## Repository Topics to Add on GitHub

Recommended topics:

```text
tauri
macos
desktop-app
developer-tools
ai-coding
claude
codex
usage-tracker
fastapi
react
source-available
```

## Pre-Submission Checklist

- Root README explains what data is read locally and links to the signed build.
- `dashboard/README.md` is project-specific, not the default Vite template.
- GitHub repository description clearly says what the app does.
- GitHub topics include `tauri`, `macos`, `developer-tools`, and `ai-coding`.
- Screenshot renders correctly in the root README.
- The submission copy says "source-available" rather than "open source".

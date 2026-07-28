# Changelog

All notable changes to AI Usage Ball are documented here.

## [0.3.0] — 2026-07-28

### Added
- **Team View**: see 2-3 teammates' remaining usage alongside your own during a pairing session. Opt-in and local-network only — turn on sharing in Settings → General (or right from the "Share" button under your orbs), then pin teammates who show up automatically, or add one by local IP if your WiFi isolates devices. Nothing ever leaves your Mac except a name and three percentages, and only when you've explicitly turned it on. Built for [uri_yap on Product Hunt](https://www.producthunt.com/products/ai-usage-ball), who asked for exactly this.
- The app now re-checks for updates every 3 days while it's running, not just at launch — and a downloaded update ready to install shows a small badge right on your desktop widgets (click it to restart), since most people don't reopen the main window often once a widget is pinned.

## [0.2.3] — 2026-07-28

### Fixed
- Popped-out desktop widgets: the liquid still didn't react to hovering, only to clicking. macOS's WebKit deliberately withholds hover events from windows sitting behind other apps, so widgets now watch the cursor natively and start the flow after it rests over the orb for a couple of seconds.

## [0.2.2] — 2026-07-27

### Fixed
- Popped-out desktop widgets: hovering or clicking the liquid could silently do nothing, since widgets sit behind other app windows and macOS doesn't pass mouse input through to an inactive window by default. Widgets now accept that first click/hover directly.

## [0.2.1] — 2026-07-12

### Added
- The Claude orb now shows a clickable **"SIGN IN"** prompt when it can't read your usage because you're signed out of claude.ai — click it to open claude.ai and log back in, instead of the orb sitting empty. (Staying logged in to claude.ai in your browser is what keeps Claude usage flowing reliably.)

## [0.2.0] — 2026-07-05

### Added
- **Hidden easter egg**: drag any crystal ball to discover a physics-based mini game — a color-matching arena, a falling-ball catch level, and a hell-difficulty lane-racing finale. Purely for fun; doesn't affect usage tracking.
- **Auto-update**: the app can now check for and install updates on its own (Settings → General → Updates, on by default — can be turned off in favor of manual checks).
- Terms and Privacy pages on the website.

### Changed
- Self-contained installer — the app no longer depends on a separately-installed Python environment on the user's machine.
- Much faster startup: cold launch dropped from ~26s to ~5s, and warm relaunch from ~13s to ~3s.
- Smoother opening animation: the usage rings now fill in from empty instead of popping in with placeholder values.
- Main window background is translucent, matching the desktop-widget look.

### Fixed
- Antigravity usage sometimes took ~20 seconds to show real data after launch.
- Claude usage occasionally took over a minute to appear, or failed to load at all.
- Window size no longer stays stretched after playing the hidden game — it resets to the default size on exit.

## [0.1.0] — 2026-07-02

Initial public release: live usage tracking for Claude, Codex, and Antigravity, with desktop widgets and a free 30-day trial.

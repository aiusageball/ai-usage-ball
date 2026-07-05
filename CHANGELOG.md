# Changelog

All notable changes to AI Usage Ball are documented here.

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

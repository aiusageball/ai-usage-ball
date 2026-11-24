# aiub-download Worker

Deployed as Worker `aiub-download` on routes `aiusageball.com/download*` and `www.aiusageball.com/download*`.
KV binding `DL` -> namespace `aiub-downloads` (cb8b32f27e4b4687b18a4053ca41f691).

- `https://aiusageball.com/download?ref=<src>`: counts one download for `<src>` (sanitized to [a-z0-9_-]{1,32}, default `direct`, per UTC day; HEAD and bot/curl user agents not counted), then 302 to the latest `AI-Usage-Ball-site.dmg` release asset.
- `https://aiusageball.com/download/stats?days=90`: JSON totals per ref and per day (unlinked).

Known `ref` values (each is stored as its own KV key `c:<UTC-date>:<ref>`):

- `site` — homepage buttons
- `direct` — `/download` with no ref
- `guide-guides` — /guides CTA
- `guide-codex` — /where-to-find-codex-usage-limits CTA
- `guide-antigravity` — /antigravity-usage-quota CTA
- `guide-claude` — /claude-code-usage-limits CTA
- `guide-claude-reset` — /claude-code-limit-reset-time CTA
- `guide-claude-not-reset` — /claude-code-usage-not-resetting CTA
- `readme` — GitHub README download link
- `brew-docs`, `ph`, `hn` — reserved for human-facing docs / launch links (not wired yet)

Do not change the Homebrew cask `url`; brew installs stay on the versioned GitHub DMG and are not counted here.

Deploy (when wrangler is logged in): from this directory, `npx wrangler deploy`. The `wrangler.toml` binds existing KV `DL` and the `/download*` routes; omit those and a deploy can overwrite dashboard routes.

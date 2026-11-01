# aiub-download Worker

Deployed as Worker `aiub-download` on routes `aiusageball.com/download*` and `www.aiusageball.com/download*`.
KV binding `DL` -> namespace `aiub-downloads` (cb8b32f27e4b4687b18a4053ca41f691).

- `https://aiusageball.com/download?ref=<src>`: counts one download for `<src>` (sanitized to [a-z0-9_-]{1,32}, default `direct`, per UTC day; HEAD and bot/curl user agents not counted), then 302 to the latest `AI-Usage-Ball-site.dmg` release asset.
- `https://aiusageball.com/download/stats?days=90`: JSON totals per ref and per day (unlinked).

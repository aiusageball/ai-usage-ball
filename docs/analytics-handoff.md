# Analytics Handoff

Cloudflare Web Analytics is active for `aiusageball.com` through its automatic
setup. It provides privacy-friendly page views, visits, referrers, and web
performance without adding an analytics service to the source tree.

## Launch Links

Use a distinct source parameter in each public launch link:

| Channel | Link |
| --- | --- |
| Show HN | `https://aiusageball.com/?ref=show_hn` |
| `r/ChatGPTCoding` | `https://aiusageball.com/?ref=reddit_chatgptcoding` |
| `r/macapps` | `https://aiusageball.com/?ref=reddit_macapps` |

Cloudflare Web Analytics records visits and referrers. GitHub Release asset
download counts are the current download signal; the Cloudflare beacon does not
provide custom download-click events.

## First Dashboard to Watch

Open Cloudflare `Analytics` -> `Web analytics` -> `aiusageball.com` the day
after each post. Compare the visit trend and referrer data with GitHub Release
DMG download counts. During the first launch cycle, the meaningful success
signal is not revenue: it is seeing at least one repeatable source produce
downloads and substantive feedback.

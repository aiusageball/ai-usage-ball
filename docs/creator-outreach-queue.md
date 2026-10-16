# AI Usage Ball Creator and Distribution Outreach Queue

This queue is for targeted, human outreach around AI Usage Ball. It is not a
mass-DM list and it is not permission to publish on somebody else's behalf.
Each target should receive a tailored note that explains why the audience is a
fit and offers a clean way to test the app.

## What we are pitching

AI Usage Ball is a source-available, local-first macOS desktop widget for
seeing remaining Claude, Codex / ChatGPT, and Antigravity usage and reset state
as three liquid gauges.

The strongest angle is visual and practical:

> A beautiful, glanceable Mac widget for deciding whether to keep coding,
> switch providers, or wait for a reset.

Use “I haven't found another macOS widget that combines these three things”
instead of an absolute “the only one” claim. Do not promise a fixed quota, and
do not offer a reward for a vote, review, or positive coverage.

## Priority queue

| Priority | Target / route | Why it fits | First action | Status |
| --- | --- | --- | --- | --- |
| A | [Mac Native](https://nativemacapps.substack.com/about) / `@best_macapps` | Native Mac apps, SwiftUI/AppKit developers, and power users are exactly the intended audience. | Submit a concise entry to the linked native-app list; then send one personal note with the visual demo. | Not contacted |
| A | [iOS Dev Tools](https://iosdevtools.substack.com/about) | The newsletter already covers AI tools and interesting Mac tools, and publishes a public feature/sponsorship contact. | Email `hi@iosdev.tools` with a reviewable build, one screenshot, and the `creator_iosdevtools` tagged link. | Not contacted |
| A | [Those Who Swift / Indie App Devs](https://thosewhoswift.substack.com/) | The audience follows Swift, indie development, and app design/building stories. | Pitch the small native utility and the design problem; ask whether it fits a future tools or indie-dev issue. | Not contacted |
| A | [Insanely Cool Tools](https://insanelycooltools.substack.com/) | The publication actively covers useful tools and has a visible interest in Mac-only utilities. | Use its public contact/social route; offer a short “why this exists” story rather than an ad blast. | Not contacted |
| A | [Indie App Catalog](https://indieappcatalog.com/news/submit) | It has a direct submit flow for app news and can create an evergreen discovery page. | Submit one factual update with the real demo and `creator_indieappcatalog` attribution. | Not contacted |
| B | [Mac Apps Library](https://www.macappslibrary.com/) | It curates Mac utilities, including developer tools and menu-bar apps. | Submit the app for the relevant collection; do not buy a placement before organic listing is tested. | Not contacted |
| B | [TheMacApps](https://themacapps.com/pricing) | It offers Mac-app discovery pages and a newsletter route. | Review the free/organic submission option first; record any paid offer separately from organic results. | Not contacted |
| B | [All Mac Apps](https://allmacapps.com/submit) | A focused app directory with an explicit submission route. | Submit a clean listing with Apple Silicon, macOS version, privacy, and download details. | Not contacted |
| B | [MacStories](https://www.macstories.net/about/) | It covers Mac apps and has a public contact route, but the editorial bar is higher. | Send a short editorial pitch only after the download/install flow is clean and the app has current screenshots. | Not contacted |
| B | [XDA / AI coding-tool writers](https://www.xda-developers.com/) | Writers who compare Claude Code, Codex, and Antigravity already understand the cross-tool limit problem. | Pitch the user problem and offer a no-obligation test; do not ask for a guaranteed article. | Not contacted |

## Recommended order

1. Submit the three low-friction directory/list entries: Mac Native, Indie App
   Catalog, and All Mac Apps.
2. Send three personalized editorial notes: iOS Dev Tools, Those Who Swift,
   and Insanely Cool Tools.
3. After the first real feedback or release improvement, approach Mac Apps
   Library, TheMacApps, MacStories, and one XDA writer.
4. Follow up once after 5–7 days. If there is no reply, stop; do not send a
   repeated campaign.

## Personal outreach note

```text
Subject: A small native Mac utility for AI coding limits

Hi [name] — I built AI Usage Ball, a source-available macOS widget that keeps
Claude, Codex / ChatGPT, and Antigravity usage and reset state visible as three
liquid gauges.

I made it because the useful decision is usually “keep going, switch tools, or
wait for a reset”, but the answer is buried in another dashboard. The app is
local-first, Apple Silicon-focused, and the visual state is the main idea.

I thought of [publication/channel] because you cover [specific audience fit].
If it seems relevant, I can provide a clean build and the original demo for an
independent look. No expectation of a positive review or coverage.

Demo/download: https://aiusageball.com/?ref=creator_[slug]
Source: https://github.com/aiusageball/ai-usage-ball

Best,
Ben
```

## Maintenance loop

- Monday: check GitHub issues, Product Hunt replies, and Cloudflare referrers.
- Tuesday: answer the oldest substantive question and turn repeated confusion
  into a FAQ or guide.
- Wednesday: publish one owned-channel update through Buffer; keep it tied to a
  real build change, screenshot, or user question.
- Thursday: send at most two new personalized outreach notes.
- Friday: record visits, tagged visits, DMG downloads, and useful feedback by
  source. Pause a source that produces impressions but no qualified action.

## Attribution rules

Every directory, newsletter, or creator gets a distinct `ref` value. Compare
that source's Cloudflare visits with the standard GitHub Release DMG download
count. Do not count `latest.json` as a download and do not infer a download
from an impression.

## Boundaries

- Buffer can automate connected owned channels; its current connected queue is
  X. LinkedIn, Threads, or other channels require their own connection before
  they can be scheduled.
- Reddit, Hacker News, and Product Hunt require a human review of the current
  thread/page and a final send confirmation. The assistant can prepare drafts,
  tagged links, reply plans, and follow-up reminders.
- Never request API keys, session tokens, upvotes, positive reviews, or
  undisclosed paid coverage.

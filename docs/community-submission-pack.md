# AI Usage Ball Community Submission Pack

These are platform-native drafts for human review and submission. They are
not Buffer posts and must not be auto-published. The author should replace any
line that does not sound like them and be available to answer replies.

## Positioning to keep

AI Usage Ball is a source-available, local-first macOS desktop widget for
seeing remaining Claude, Codex / ChatGPT, and Antigravity usage and reset
status as three liquid gauges.

Use “I haven't found another macOS widget that combines these three things”
instead of an absolute “唯一一款” claim.

Do not promise a fixed quota number. Provider plans, models, accounts, and
limits change. Do not include a real account's quota value unless the author
has deliberately chosen to show it.

## 1. r/ChatGPTCoding — project showcase or current self-promotion thread

Link: `https://aiusageball.com/?ref=reddit_chatgptcoding`

### Suggested title

I built a macOS widget that keeps Claude, Codex, and Antigravity usage visible
before a coding task runs out of room

### Suggested body

I kept running into the same interruption: I would start a long coding task,
then discover that one of my AI tools was close to its usage limit. The usage
pages are useful, but I wanted the answer to stay visible while I worked.

So I built AI Usage Ball, a macOS desktop widget with three liquid gauges for
Claude, Codex / ChatGPT, and Antigravity. It shows the remaining usage and
reset state that the local readers can obtain from the signed-in sessions.

The goal is deliberately small: one glance before starting a long task, so I
can continue, switch tools, or wait for a reset. The source is available for
inspection, and the signed macOS build is here:

`https://aiusageball.com/?ref=reddit_chatgptcoding`

I am looking for practical feedback rather than a review. Which part would you
want to see first: remaining usage, reset time, weekly allowance, or a warning
before the limit?

I built this project, so I am affiliated with it.

### Reply plan

- Answer questions about authentication, local reads, supported providers,
  and what is not yet supported.
- If someone reports a mismatch, ask for provider, plan, client, and an
  account-safe screenshot; never ask for tokens or API keys.
- Do not ask for upvotes, stars, or positive reviews.

## 2. r/macapps — only if the current rules allow developer posts

Link: `https://aiusageball.com/?ref=reddit_macapps`

### Suggested title

AI Usage Ball — a liquid-gauge macOS widget for AI coding-tool usage

### Suggested body

I made a small macOS utility for people who use more than one AI coding tool.

AI Usage Ball keeps Claude, Codex / ChatGPT, and Antigravity usage visible as
three liquid gauges, including the reset state available to the local session
readers. It is meant to stay on the desktop, not become another dashboard to
remember to open.

The app is source-available, local-first, and distributed as a signed Apple
Silicon build. It is still early, so I would especially like to know whether
the visual state is understandable at a glance and which macOS behavior feels
unclear.

Demo and download: `https://aiusageball.com/?ref=reddit_macapps`

I built this project and am affiliated with it. If developer submissions are
not allowed here, I will leave this out of the feed.

### Reply plan

- Keep the thread about macOS behavior, installation, privacy, and design.
- Do not repost if a moderator removes it; check the current rules first.
- Stop posting in this community if the contribution mix becomes mostly
  self-promotion.

## 3. Antigravity quota discussion — use only the current allowed thread

Link: `https://aiusageball.com/?ref=reddit_antigravity`

### Comment draft

I made a macOS widget for the “what is left before I start this task?”
problem. AI Usage Ball puts the available Antigravity, Claude, and Codex /
ChatGPT usage state into three liquid gauges.

It is not intended to replace Antigravity's official `/usage` or `/quota`
panel. The official panel remains the source of truth; this is the persistent
desktop view for people switching between tools.

I am looking for reports of what is confusing or missing, not votes or a
positive review: `https://aiusageball.com/?ref=reddit_antigravity`

## 4. Hacker News — Show HN, only when ready to be present

Link: `https://aiusageball.com/?ref=show_hn`

### Suggested title

Show HN: AI Usage Ball — a macOS widget for AI coding-tool usage limits

### Suggested submission text

AI Usage Ball is a small macOS desktop widget I built to keep AI coding-tool
usage visible while working. It reads the usage information available from
local authenticated sessions and renders Claude, Codex / ChatGPT, and
Antigravity as three liquid gauges with reset state.

I did not want another analytics dashboard. The useful decision is usually
whether to continue a long task, switch tools, or wait for a reset. The app is
source-available and the signed Apple Silicon build can be tried here:

`https://aiusageball.com/?ref=show_hn`

Repository: `https://github.com/aiusageball/ai-usage-ball`

The interesting engineering questions are the provider-specific readers,
account/session boundaries, and how to make a compact visual indicator useful
without inventing quota data. I will be around to answer implementation and
privacy questions.

### HN readiness checklist

- The download works on a clean Apple Silicon Mac.
- The author can answer comments for several hours.
- The post describes what was made and why, not only the landing page.
- No friends are asked to upvote or comment.
- The author writes the final version in their own voice; this draft is only a
  starting point.

## 5. Existing Product Hunt page — maker update, not a relaunch

Link: `https://aiusageball.com/?ref=producthunt`

### Suggested maker comment

A small update from the maker: I have been refining the part of AI Usage Ball
that matters most to me — seeing the remaining usage and reset state without
opening another dashboard.

The current build keeps Claude, Codex / ChatGPT, and Antigravity in three
liquid gauges on macOS. I am now looking for people who use two or more of
these tools during real coding work.

If you try it, the most useful feedback is specific: what did you expect the
gauge or reset state to mean, and what felt unclear? Positive or critical
feedback is welcome.

### Discussion prompt

What is the moment you most want a quota widget to help with: starting a long
task, choosing a provider, or waiting for a reset?

Do not request votes, offer rewards for votes, or send this same text as a mass
DM.

## Measurement

Use the exact link for the destination above, then compare:

- Cloudflare visits and referrer for the matching `ref` value;
- change in standard `AI-Usage-Ball.dmg` GitHub Release downloads;
- actual app launches when observable;
- substantive feedback and issues opened.

The goal is one repeatable source of downloads or useful feedback, not a large
impression count.

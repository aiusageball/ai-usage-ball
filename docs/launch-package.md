# Community Launch Package

Use each item once, with its own source URL. Do not publish the same wording in
multiple communities.

## Launch Order

1. Publish the Hacker News item when the founder can spend several hours
   answering questions.
2. Publish to the current `r/ChatGPTCoding` self-promotion thread.
3. Publish to `r/macapps` only after reading its current rules in the browser
   and completing any required account steps.

## Hacker News

Hacker News expects a real, usable project rather than a landing page. Link
directly to the site because visitors can download the signed build without an
account or email.

Title:

```text
Show HN: AI Usage Ball - a local macOS app for Claude and Codex limits
```

URL:

```text
https://aiusageball.com/?ref=show_hn
```

First comment, posted immediately after the submission:

```md
I made this after repeatedly learning I had hit a Claude or Codex limit only
when I was already in the middle of a task.

AI Usage Ball is a small macOS menu bar / desktop app that keeps remaining
usage and reset times visible for Claude, Codex / ChatGPT, and Antigravity. It
reads existing local sessions and talks directly to the providers' own usage
endpoints; there is no account or proxy server run by me. The source is
available so the local readers can be audited.

The signed build has a 30-day trial, then costs A$9.99 once. I would especially
value feedback on: which provider limits are actually useful to see, whether
the privacy model is clear enough, and where the readings are wrong or stale.
```

Suggested answers to likely questions:

```md
Why does it need local session access?

It uses the sessions that are already present on the Mac to ask each provider
for the same usage state their own clients can display. The implementation is
in the repository so people can inspect the exact readers.
```

```md
Why is it paid if the source is available?

The official build is signed, notarized, and maintained as a paid one-time
purchase. The source is available for auditability and noncommercial personal
builds under the PolyForm Noncommercial License.
```

```md
Why not just open the provider dashboard?

That works when I remember to do it. The point is to make the reset countdown
and remaining allowance visible during a coding session, before a limit
interrupts it.
```

## `r/ChatGPTCoding`

Post this in the newest official self-promotion thread, not as a standalone
submission. That thread currently permits one promotion per project.

```md
I kept hitting a Codex or Claude limit in the middle of a task, then losing the
thread while I waited for the reset. So I made a small macOS app that keeps the
remaining allowance and reset time visible in the menu bar / on the desktop.

It supports Claude, Codex / ChatGPT, and Antigravity. It reads existing local
sessions, talks directly to the providers, and the source is available to
audit. The signed build has a 30-day trial, then is A$9.99 once.

I am most interested in feedback from people who switch between these tools:
which limits or alerts would actually change how you plan a coding session?

https://aiusageball.com/?ref=reddit_chatgptcoding
```

## `r/macapps`

Before posting, open the community rules while signed in and complete any
required "read the rules" process. Use the correct paid/lifetime flair.

Title:

```text
I made a local menu bar app for seeing Claude and Codex limits before they interrupt a session
```

Body:

```md
I kept discovering that an AI coding session was out of quota only after I had
already committed to the task. I made AI Usage Ball to keep remaining usage and
reset times visible in the menu bar or as small desktop gauges.

It supports Claude, Codex / ChatGPT, and Antigravity. The usage readers run
locally on the Mac and the source is available to inspect. The app is signed
and notarized, has a 30-day trial with no card, then costs A$9.99 once.

I would love feedback on the UI and whether the local-data explanation feels
clear enough. I am the developer.

https://aiusageball.com/?ref=reddit_macapps
```

## Demo Recording Brief

Record a 20-30 second screen capture with no narration:

1. Start in an active coding editor with the three compact gauges visible.
2. Show a Claude gauge with a reset countdown, then open the app to show the
   provider names and the fuller state.
3. Return to the editor with the gauges unobtrusively visible.
4. End on `30-day free trial, no card required` for two seconds.

Do not use synthetic quota values that look like a product mockup. A real
anonymized account state is more credible.

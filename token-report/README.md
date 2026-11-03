# Token Report

![The Token Report band (marked) above the prompt, under a row of other mods: Context 125k, up 1k in the last turn, Cache 59m, Session about 0.69 €, 5h limit 74% with its reset in 1h 8m, Weekly 49%.](../visual-assets/token-report/band-warm.webp)

<h4 align="center">What does it do?</h4>

<p align="center">It shows a band above the prompt: how big the chat is and how fast it grows,<br>
how long the cache stays warm, what the session cost and how much of your plan is left.<br>
A Settings pane decides what happens to the cache and the chat while you are away.</p>

<h4 align="center">Why?</h4>

<p align="center">A long chat is cheap while its cache is warm and expensive once it goes cold.<br>
Claude Code does not show when that happens. Token Report shows it,<br>
asks before an expensive send and lets you choose what happens while you are away.</p>

> **Desktop app only.** Token Report is a mod for the Code tab of the Claude desktop app. It was built and tested there (Claude Code 2.1.309). The terminal is untested.

## Install

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `byMarcoVogt/mods`, then **Add plugin** and pick `token-report`.

From a terminal session:

```
/plugin install token-report --marketplace byMarcoVogt/mods
```

Answer `y` to add the marketplace, then pick the user scope. The band shows up in the next session. `/tokens` opens the Settings pane, and so does **≣ Report** on the band.

**Update:** `/plugin marketplace update bymarcovogt-mods`. **Uninstall:** `/plugin uninstall token-report`.

## Real use

**When the cache has gone cold, the band says what the next send costs.**

![Real band (marked): Context 133k, the cache cold, the next send rewriting 133k for about 0.95 €, Session about 16.15 €, Weekly 36%.](../visual-assets/token-report/band-cold.webp)

**Before an expensive send on a cold cache, it asks.**

![Real dialog (marked), in a desktop app set to German: Your chat went cold. Sending reloads all 124k (about 0.55 €). Compacting first costs about the same now, but every later message is cheaper. Choices: Send anyway, Compact, then send, Cancel. Below it the band, with the cache working.](../visual-assets/token-report/cold-dialog.webp)

**The Settings pane: what happens to the cache and the chat while you are away, and at your threshold.**

![Real Settings pane: cards for Chat 260k, Cache 59m, Session about 68.19 €, Plan subscription, then the groups Plan, Money, Cache management and Context management.](../visual-assets/token-report/settings.webp)

## The band

- **Context** in tokens, with the growth of the last turn. It turns orange and then red as it nears your threshold.
- **Cache**: minutes until the cache goes cold. Cold means the next message re-reads the whole chat at the write price.
- **Session** cost. On a subscription this is what the session would cost at API prices.
- **Plan limits** (5 hours and weekly) with their reset time, on a subscription.
- **⤓** compacts the chat now, while the cache is warm.

## Settings

Settings apply to **Global** (every session), **Project** (a `.token-report/settings.json` in the project folder) or **Session** (this chat only). Session beats Project, and Project beats Global.

### When you're away

Two questions, four choices:

| | Compact the chat | Keep the full chat |
|---|---|---|
| **Let the cache go cold** | **Compact** | **Keep full** (default) |
| **Keep the cache warm first** | **Cache Warmer, then compact** | **Cache Warmer, then keep full** |

- **Compact.** Claude Code compacts idle chats itself from its idle threshold on (200k by default). Below that threshold, Token Report compacts once per pause, 10 minutes before a 1-hour cache goes cold, for chats of 50k and more. On a 5-minute cache it does nothing. One compaction reads the chat while it is still warm and writes a summary.
- **Keep full** (default). Nothing compacts while you are away. Claude Code's own idle summary is refused as well, and the full chat stays. Out of the box the mod spends no tokens on its own.
- **Cache Warmer.** A short request reads the chat a few minutes before the cache would expire, for a set time after your last message: 1, 2 or 5 hours on a 1-hour cache, or 15, 30 or 45 minutes on a 5-minute cache. Each ping costs a cache read of the chat. Then it compacts or keeps the full chat, as chosen.

### Other settings

| Setting | Choices | Default |
|---|---|---|
| Plan type | Detect automatically, Subscription, API key | Detect |
| Currency | $, € | $ |
| Ask before a cold send | Never, Above 0.25, Above 0.50, Above 1.00, Always | Above 0.50 |
| Threshold | 200k, 300k, 400k, 600k, Max, Custom (50k at least) | 400k |
| At the threshold | Off, Reminder, Ask, Compact | Reminder |
| /compact | No added instructions, Added instructions | None |

- **Ask before a cold send.** If the cache has gone cold and your message would cost more than the amount you set, a dialog asks first. Its choices are **Send anyway**, **Compact, then send** (your message goes again on the small chat), or **Cancel**. Closing the dialog cancels. If Claude Code already wrote an idle summary, the middle choice is **Use the summary**.
- **At the threshold.** The Reminder and Ask come back every further 100k.
- **/compact instructions** go with every compaction the mod starts and with Claude Code's idle summary.

Claude Code's own switches still apply. `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` sets the idle threshold (minimum 100k), and the mod reads it. `"idleCompaction": false` in Claude Code's settings turns idle compaction off. `"promptCacheTtl": "5m"` or `"1h"` sets the cache lifetime.

## What it costs

Watching costs nothing. The band reads usage that Claude Code already has and changes nothing Claude reads. Tokens are spent only:

- by a compaction: **Compact** while you are away, **Compact** at the threshold, **⤓**, or **Compact, then send**
- by Cache Warmer pings, if you choose a Cache Warmer. On a 150k chat with Opus, a ping costs about $0.06 at API prices.

## Privacy

- Reads the session's usage locally.
- Writes to the mod's own store, and to `.token-report/settings.json` only when you save a setting under Project.
- Uses the network only for the euro rate (the ECB rate from frankfurter.app), and only when € is chosen.
- No telemetry.

A project's `.token-report/settings.json` applies to everyone who opens that folder, including a Cache Warmer or compact instructions. Look at it before you trust a repository you cloned.

## Known limits

- The ⓘ tooltips show on mouse hover only, not with the keyboard or on touch.
- A dropdown in the pane can flicker while you hover over it. This comes from the desktop app.
- **Compact, then send** sends your text again. Pasted images and files can't be sent again, so for those messages the dialog offers only **Send anyway** and **Cancel**.
- **Use the summary** is not yet tested in a live session.

## License

[MIT](LICENSE)

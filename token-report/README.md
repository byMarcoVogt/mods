# Token Report

![The Token Report band (marked) above the prompt, under a row of other mods: Context 125k, up 1k in the last turn, Cache 59m, Session about 0.69 €, 5h limit 74% with its reset in 1h 8m, Weekly 49%.](../visual-assets/token-report/band-warm.webp)

<h4 align="center">What does it do?</h4>

<p align="center">It shows above the prompt what your chat costs and when its cache goes cold,<br>
and it decides what happens to the chat while you are away.</p>

## Why a pause costs money

Every message sends the whole chat again. Once the cache has gone cold, all of it is written into the cache again:

| A 150k chat on Opus 5.5 | Your next message costs |
|---|---|
| Cache warm | ≈ $0.06 |
| Cache cold | ≈ $1.20, 20 times as much |

The cache lives 1 hour on a subscription and 5 minutes with an API key. Claude Code does not show when it goes cold.

## The band

- **Context**: the chat's size and what the last turn added. At your threshold (400k by default) it reminds you, asks or compacts.
- **Cache**: minutes until the cache goes cold.
- **Session**: what this session has cost so far.
- **5h** and **Weekly**: your plan limits and when they reset, on a subscription.
- **≣ Report** opens Settings. **⤓** compacts the chat now, while the cache is warm.

Once the cache has gone cold, the band says what the next send costs:

<img src="../visual-assets/token-report/band-cold.webp" width="720" alt="The band (marked): Context 133k, the cache cold, the next send rewriting 133k for about 0.95 €, Session about 16.15 €, Weekly 36%.">

## Before a cold send

If the cache has gone cold and your message would cost more than a set amount (0.50 by default), a dialog asks first:

<img src="../visual-assets/token-report/cold-dialog.webp" width="400" alt="The cold-send dialog on a 5-minute cache, in a desktop app set to German: Your chat went cold. Sending reloads all 124k (about 0.55 €). Compacting first costs about the same now, but every later message is cheaper. Choices: Send anyway, Compact, then send, Cancel.">

- **Send anyway.** The whole chat is written into the cache again.
- **Compact, then send.** The chat is compacted first, then your message goes again on the small chat. It costs about the same now, but every later message is cheaper. If Claude Code already wrote a summary while you were away, this choice reads **Use the summary** and costs almost nothing.
- **Cancel.** Nothing is sent. Closing the dialog cancels too.

## When you're away

Claude Code compacts idle chats only from 200k up. Below that, you come back to a cold, full chat. Token Report asks two questions:

| | Keep the full chat | Compact the chat |
|---|---|---|
| **Let the cache go cold** | **Keep full** (default). Spends nothing. | **Compact.** Once, while still warm. |
| **Keep the cache warm first** | **Cache Warmer, then keep full** | **Cache Warmer, then compact** |

- **Compact** fills the gap from 50k to 200k. Above it, Claude Code's own summary does the job.
- **Keep full** also refuses Claude Code's summary.
- **Cache Warmer** pings before the cache expires, for 1, 2 or 5 hours. 20 pings cost about one cold send.

## Settings

**≣ Report** on the band, or `/tokens`, opens the Settings pane:

<img src="../visual-assets/token-report/settings.webp" width="720" alt="The Settings pane with a note beside each row. Where settings apply: Global, Project or Session. Choose your plan: Subscription or API key. Currency: measure in US dollars or euros. What happens while you are away? It can ask before an expensive send. Choose your preferred context size. What should it do there? Add instructions for every compaction.">

## What it costs

Watching costs nothing. The band reads usage that Claude Code already has and changes nothing Claude reads. Out of the box the mod spends no tokens. Tokens go only to what you choose: a compaction (while you are away, at the threshold, ⤓, or Compact, then send) and Cache Warmer pings.

## Install

Token Report is a mod for the Code tab of the Claude desktop app, built and tested there (Claude Code 2.1.309). The terminal is untested.

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `byMarcoVogt/mods`, then **Add plugin** and pick `token-report`.

From a terminal session:

```
/plugin install token-report --marketplace byMarcoVogt/mods
```

Answer `y` to add the marketplace, then pick the user scope. The band shows up in the next session.

**Update:** `/plugin marketplace update bymarcovogt-mods`. **Uninstall:** `/plugin uninstall token-report`.

## License

[MIT](LICENSE)

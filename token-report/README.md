# Token Report

![The Token Report band (marked) above the prompt, under a row of other mods: Context 125k, up 1k in the last turn, Cache 59m, Session about 0.69 €, 5h limit 74% with its reset in 1h 8m, Weekly 49%.](../visual-assets/token-report/band-warm.webp)

<h3 align="center">Long chats stay cheap, even after a break.</h3>

<p align="center">An add-on for the Claude desktop app. It makes clear what drives the cost of a session<br>
(context size, prompt cache, model), helps keep that cost low, and warns you<br>
before an expensive step (a send to a cold cache).</p>

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

## What it touches

- **Hooks:** prompt submit, turns, compaction, model switch and session start and end. It reads token usage from Claude Code on your machine; nothing is sent anywhere.
- **Network:** only with € chosen, at most twice a day, one call to api.frankfurter.app for the ECB dollar-to-euro rate. No telemetry.
- **Tokens:** out of the box it spends none. The Cache Warmer, if you switch it on, sends short pings that read the whole chat at the cache price, and compacting writes a summary like any compaction.
- **Files:** Settings for Project scope go into `.token-report/settings.json` in your project folder. Global and Session settings stay in Claude Code's own plugin storage.

## Install

**In the Claude desktop app** (Code tab):

1. Click **+** next to the prompt box, then **Plugins**.
2. **Add marketplace**: `byMarcoVogt/mods`
3. **Add plugin**: `token-report`

**From a terminal, no questions asked** (also for agents):

```bash
claude plugin marketplace add byMarcoVogt/mods
claude plugin install token-report@bymarcovogt-mods
```

`claude plugin list` then shows token-report as enabled. The band shows up in your next session.

- **Update:** `claude plugin marketplace update bymarcovogt-mods`, then `claude plugin update token-report@bymarcovogt-mods`
- **Uninstall:** `claude plugin uninstall token-report@bymarcovogt-mods`

Built and tested in the desktop app (Claude Code 2.1.309). The terminal is untested.

## Development

```bash
git clone https://github.com/byMarcoVogt/mods
claude plugin test mods/token-report
claude plugin validate mods/token-report
```

The type files in `.claude-plugin/types/` are not in the repo. Claude Code writes them when it loads the mod from a folder it watches (`--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`). After that, `tsc --project mods/token-report` type-checks it.

## License

[MIT](LICENSE)

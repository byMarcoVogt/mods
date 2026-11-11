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
| Cache cold | ≈ $1.20 |

The cache lives 1 hour on a subscription and 5 minutes with an API key. Claude Code does not show when it goes cold.

## The band

- **Context**: the chat's size and what the last turn added. At your threshold (400k by default) it reminds you, asks or compacts.
- **Cache**: minutes until the cache goes cold.
- **Session**: what this session has cost so far.
- **5h** and **Weekly**: your plan limits and when they reset, on a subscription. The band shows the newest reading it has, from Claude Code's last reply or the desktop app's usage card, and adds "as of 14:23" when that is older than 10 minutes. A per-model weekly limit takes Weekly's place, named ("Weekly Fable: 98%"), when it is fuller and the session runs on that model or it is at 90% or more.
- **≣ Report** opens the pane. **⤓** compacts the chat now, while the cache is warm.

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

**≣ Report** on the band, or `/tokens`, opens the pane. It has two pages, Settings and Agents. Settings:

<img src="../visual-assets/token-report/settings.webp" width="720" alt="The Settings pane with a note beside each row. Where settings apply: Global, Project or Session. Choose your plan: Subscription or API key. Currency: measure in US dollars or euros. What happens while you are away? It can ask before an expensive send. Choose your preferred context size. What should it do there? Add instructions for every compaction.">

The screenshot shows the Settings of 1.1. Since then the page has gained the Profile row at the top, Turns nobody typed under Context management, and a section Agents and side sessions (see below).

## New in v2

Since 1.3, Token Report also looks at work that starts without you: turns nobody typed, agents, and sessions that a session starts. **These features are new.** The test suite covers them, but they have not yet seen long live use. **Their defaults only count and never step in.**

| Setting | Count only (default) | Act |
|---|---|---|
| **Turns nobody typed**: a message from another session, a notification, a schedule, the brief of a started session | Runs as it comes. Never a dialog: Ask at the threshold becomes a pop-up. | Compacts after such a turn above the threshold, and before one that would reload a cold chat above the cold-send amount. |
| **Agent starts** | Agents start as asked and are counted. | **Hand back:** a research agent that would inherit Opus or Fable is sent back once to name a cheaper model. A call that names a model always starts. |
| **Session starts** | New sessions start as asked and are counted. | **Hand back:** a fork of a large or cold chat is sent back once to start fresh. A fresh start from Opus or Fable with no model named is sent back once to name one. |

- **Profile**, the first row in Settings, sets all three at once. **Auto** (default) counts, **Managed** acts. A row you change by hand wins and is named beside the profile. The idea: Auto everywhere, Managed in a project where you run several sessions at once.
- **A hand-back** is a refusal that the calling model reads, with the reason. Never a window or a pop-up.
- **The Agents page** shows which agents and sessions this session started, on which model, and what they cost at API prices. Next to it, what the same work would have cost under Managed, with that assumption printed under it. Sessions started from this one report back, up to three layers deep. A session on an older version, on another machine or in the cloud reads "not reported".

## Event log

Off by default. Set the mod's option **Event log folder** (in the app's plugin settings for token-report) to a folder, and the mod adds one JSON line per event to `events-YYYY-MM.jsonl` there. I use it to feed a cost dashboard. Any script that reads JSON Lines will do.

Each line starts with `ts` (UTC), `session` and `kind`, then the fields of that kind:

| `kind` | Written when |
|---|---|
| `session_start` | after the first reply: model, billing, cache lifetime, mod version, profile |
| `limit` | a plan limit's percent or reset time changed |
| `limit_reset` | a plan limit fell before its reset time (an early reset): percent and reset time before and after |
| `compact` | a compaction went through: tokens before and after, who started it, why, its price |
| `warm_start`, `keep_warm`, `warm_stop` | a Cache Warmer pause, each ping, its end with the total |
| `cold_send` | the cold-send dialog was answered: tokens, price, choice |
| `wake` | a turn nobody typed: origin, cold or warm, what it would reload, what happened |
| `agent_start`, `agent_end` | an agent started, and what it used when it ended |
| `hand_back`, `hand_back_answer` | an agent or session start was sent back, and what the model did next |
| `side_start` | this session started another one |

Ids and numbers only: no titles, prompts or paths. Kinds and fields are only ever added, so skip what you do not know. Past 3 MB a month goes on in `events-YYYY-MM.2.jsonl`.

## What it touches

- **Hooks:** prompt submit, turns, tool calls, agent starts, compaction, model switch and session start and end. It reads token usage from Claude Code on your machine. Nothing is sent anywhere.
- **Desktop app tools:** it reads the app's usage card for plan limits: at session start, at each turn's end, when you write after a pause, and every 5 minutes while the band is in view. One call at a time, local, no tokens. Once per session it also asks the app whether another session started this one. A denied call is not repeated.
- **Network:** only with € chosen, at most twice a day, one call to api.frankfurter.app for the ECB dollar-to-euro rate. No telemetry.
- **Tokens:** out of the box it spends none. The Cache Warmer, if you switch it on, sends short pings that read the whole chat at the cache price. Compacting, by you, by a setting or under Managed, writes a summary like any compaction.
- **Files:** Settings for Project scope go into `.token-report/settings.json` in your project folder. Global and Session settings stay in Claude Code's own plugin storage. So does what started sessions report for the Agents page, for 3 days. The event log writes only into the folder you name.

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

List prices live in `prices.json`. A mod loads only code files, so `hooks/prices.ts` is generated from it: after an edit, run `node gen-prices.mjs` in the mod folder.

The type files in `.claude-plugin/types/` are not in the repo. Claude Code writes them when it loads the mod from a folder it watches (`--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`). After that, `tsc --project mods/token-report` type-checks it.

## License

[MIT](LICENSE)

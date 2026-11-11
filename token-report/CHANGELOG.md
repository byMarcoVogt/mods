# Changelog

## 1.2.0 (2026-11-10)

- An event log, off by default. Set the mod's option "Event log folder" to a folder, and the mod adds one JSON line per event to `events-YYYY-MM.jsonl` there, for a dashboard or your own scripts to read: session start, plan-limit changes, compactions, the cold-send dialog and its choice, Cache Warmer start, pings and stop. Ids and numbers only, no prompt text. Left empty, the mod reads and writes nothing for it.
- Plan limits in the log also come from the desktop app's usage card when the mod may ask for it, which adds the per-model weekly windows.

## 1.1.1 (2026-11-10)

- A turn that resumes on a cold cache asks too, for example when you answer a question from Claude an hour later: Send anyway or Cancel. Before, only the first request of your own message was checked.
- A model switch on a warm cache goes through, and a pop-up names what the switch re-caches. Before, the desktop app turned the check into a block.
- A compaction that Claude Code refuses while a turn runs is queued and runs at the next quiet moment, instead of showing as failed.

## 1.1.0 (2026-11-03)

- A narrow band stays on one line: first the extras go (what the last turn added, the reset's clock time), then the labels, then Weekly. Only then do whole segments wrap, never with a bar at a line's edge.

## 1.0.0 (2026-11-03)

First public release.

- The band above the prompt: context and its growth, cache clock, session cost, plan limits, ⤓ Compact.
- The Settings pane: Plan, Money, Cache management, Context management, each for Global, Project or Session.
- When you're away: Compact, Keep full, Cache Warmer then compact, Cache Warmer then keep full.
- A dialog before an expensive send on a cold cache.
- A threshold with Off, Reminder, Ask or Compact.

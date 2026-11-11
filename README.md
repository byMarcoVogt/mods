# Mods

Mods I built for the Code tab of the Claude desktop app. A mod is a plugin that changes Claude's own interface: a band above the prompt, a pane beside the chat, a dialog.

| Mod | What it does |
|---|---|
| [Token Report](token-report) | Shows context, cache and cost above the prompt, and decides what happens to the cache and the chat while you are away. New in v2: what agents and the sessions you start cost. |

> **Desktop app only.** The mods are built and tested in the desktop app's Code tab. The terminal is untested.

## Install

In the desktop app: click **+** next to the prompt box, then **Plugins**. **Add marketplace** `byMarcoVogt/mods`, then **Add plugin** `token-report`.

From a terminal, no questions asked (also for agents):

```bash
claude plugin marketplace add byMarcoVogt/mods
claude plugin install token-report@bymarcovogt-mods
```

`claude plugin list` then shows token-report as enabled.

## License

[MIT](LICENSE)

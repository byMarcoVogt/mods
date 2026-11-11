// token-report's $.state contract: what the band and the Settings pane draw from.
// `rev` counts ledger changes so readers redraw; `ui` says whether the pane is open; `settings` holds the
// switches; `view` is the pane's own state (scope picked, a field opened); `tick` the band's animation frame.

export type Settings = {
  billing: 'auto' | 'subscription' | 'api'
  // Context management: the threshold in tokens (0 = Max, Claude Code's own auto-compact point), and
  // what happens once a turn crosses it, again every further 100k.
  // remind: a pop-up and Compact in the band · ask: a dialog (Compact / Not now / Stop asking) ·
  // compact: /compact right after that turn, while the cache is warm
  contextTarget: number
  atTarget: 'off' | 'remind' | 'ask' | 'compact'
  // Turns nobody typed (a peer session's message, a notification, a schedule, a started child's brief).
  // count: behave as on any turn but never a dialog, and log what act would have done · act: compact
  // after such a turn above the threshold, and compact before one that wakes a cold cache
  unattended: 'count' | 'act'
  // Agent starts (v2 slice 2). count: start as asked, log what act would do · act: a research or
  // gathering agent that would inherit Opus or Fable is handed back once to name a model; one that names
  // an expensive model starts with one note per session
  agentStarts: 'count' | 'act'
  // Session starts (start_session, hand_off_to_session). count: as asked, logged · act: a fork of a large
  // chat is handed back to start fresh; a fresh start with no model from Opus or Fable to name one
  sessionStarts: 'count' | 'act'
  // Cache management, while you are away: two by two. Cache Warmer or not, then compact or keep the full
  // chat. Compact: under Claude Code's idle compaction threshold the mod compacts shortly before the cache
  // goes cold; from it on, Claude Code's own idle compaction does. Keep full: neither compacts (Claude
  // Code's idle summary is refused); the next message pays the reload.
  away: 'compact' | 'keep' | 'warm-compact' | 'warm-keep'
  // How long the Cache Warmer runs after your last message: hours on a 1 h cache, minutes on a 5 min one
  keepWarm: '15m' | '30m' | '45m' | '1h' | '2h' | '5h'
  // Added to every compaction the mod starts (and to Claude Code's idle summary); '' = none
  compactNote: string
  // Before a message on a cold cache, a dialog asks first when reloading costs more than this (your
  // currency); off: never; any: every cold send
  coldAsk: 'off' | '0.25' | '0.5' | '1' | 'any'
  currency: 'usd' | 'eur'
  // Euros per dollar: the ECB rate once € is chosen, else the fixed fallback
  eurRate: number
}

export type UiState = { isOpen: boolean }

// Inside the augmentation `Settings` would name claude-code's own settings type: alias ours first.
export type TrSettings = Settings

declare module 'claude-code' {
  interface PluginState {
    'token-report': {
      rev: number
      ui: UiState
      settings: TrSettings
      view: Record<string, string>
      tick: number
    }
  }
}

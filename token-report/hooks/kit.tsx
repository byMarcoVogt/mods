// What the Settings page and the pane frame draw with, plus the shared look. The page never touches
// `$`: everything it reads comes in `data`, everything it does goes through `act`.
import type { ElementTable } from 'claude-code'

import type { Settings } from '../types'
import type { Billing, Ledger } from './ledger'
import type { LineState, UsageView } from './line'

type Desktop = ElementTable<'desktop'>

// What a page may draw with: the desktop's table; Svg, Select and Input optional so the terminal degrades.
export type UI = Pick<Desktop, 'Box' | 'Text' | 'Button'> & Partial<Pick<Desktop, 'Svg' | 'Select' | 'Input'>>

// Everything the mod knows right now, read-only.
export type Data = {
  now: number
  L: Ledger
  s: LineState
  usage: UsageView
  // Context window, Claude Code's auto-compact point, and the threshold in force (tokens)
  window: number | null
  compactAt: number | null
  target: number | null
  // Settings the project and this session override, and the project folder's name
  projectKeys: string[]
  sessionKeys: string[]
  folder: string
  // The chat's size right after this session's last compaction (null before one): a measured summary size
  lastSummary: number | null
  // Claude Code's idle compaction threshold (CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS, 200k unset); null when
  // its idle compaction is off (idleCompaction: false). Under it the mod compacts, from it Claude Code does.
  idleThreshold: number | null
  billing: { billing: Billing; why: string }
  // Main-thread cache lifetime in minutes
  ttlMin: number
  // Minutes left on the main cache clock (null before the first request, ≤ 0 when cold)
  cacheLeft: number | null
  // What the next send rewrites if cold, USD at the list price of the last main model
  rewriteUsd: number | null
  // One Cache Warmer ping now (a fork reading the chat), USD
  pingUsd: number | null
  // Context size after each main turn, with the turn's cost (the band's "(↑…)")
  series: { at: number; turnId: string; ctx: number; usd: number; rewrite: boolean }[]
  // Euros per dollar: the ECB reference rate (isLive), else the fallback constant
  fx: { rate: number; asOf: string; isLive: boolean }
}

// What the page can do. Each returns its promise: return it from onPress so the press settles after.
export type Act = {
  // Into the scope picked at the top of Settings: Global, Project or Session
  setSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => Promise<unknown>
  // Claude Code's own compaction, the same call /compact makes
  compact: () => Promise<unknown>
}

export type PageCtx = {
  ui: UI
  data: Data
  settings: Settings
  // The pane's own state (scope picked, a field or ⓘ opened), kept for the session
  get: (key: string, fallback: string) => string
  set: (key: string, value: string) => void
  act: Act
  columns: number
}

// ---- the look ------------------------------------------------------------------------------
// Same meaning everywhere: green calm, orange warning zone, red past it.
export const C = {
  ok: '#5fc08a', warn: '#e8a24a', red: '#ee7b70',
  muted: '#8a8a8a', frame: '#3a3a3a',
} as const

export const NA = '–'
export const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
export const k = (n: unknown) => (!num(n) ? NA : Math.abs(n) >= 1_000_000 ? (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M' : Math.round(n / 1000) + 'k')
// Money in the chosen currency, the € sign after the amount: `≈ 1.12 €`, `$1.30`.
// The spaces are non-breaking (NB): a narrow pane never splits `1.12` from `€` or `≈` from the amount.
export const NB = ' '
export const money = (usd: number | null | undefined, s: Pick<Settings, 'currency' | 'eurRate'>, mark: '≈' | '~' | '' = '≈') => {
  if (!num(usd)) return NA
  const pre = mark ? mark + NB : ''
  if (s.currency === 'usd') return usd < 0.005 ? '<' + NB + '$0.01' : pre + '$' + usd.toFixed(2)
  const eur = usd * s.eurRate
  return eur < 0.005 ? '<' + NB + '0.01' + NB + '€' : pre + eur.toFixed(2) + NB + '€'
}
export const mins = (m: number | null) => (!num(m) ? NA : m >= 60 ? Math.floor(m / 60) + 'h ' + Math.round(m % 60) + 'm' : Math.max(0, Math.ceil(m)) + 'm')

// Rules for drawing (found on 2.1.309):
// - A Button holds text only; its colours are dropped on desktop; no Svg inside. Build one label string.
// - Svg is a leaf and takes no clicks: put the click on a Button beside it.
// - Select: at most 64 options. One drawing holds at most 100,000 characters. One invalid prop refuses the whole pane.
// - `plain` takes only `true` or nothing: spread it conditionally.
// - Never name a local `h` where JSX is in scope: JSX compiles to `h(...)`, the shadow breaks the page.

// The band above the prompt. Draws only; every number comes from Data (ledger + engine usage).
//   [≣ Report]  Context: 184k (↑38k) [⤓] │ Cache: 52m │ Session: ≈ 3.82 € (↑0.21 €) │ 5h: 64% ↻ 1h 50m (14:30) │ Weekly: 81%
import type { RenderElement } from 'claude-code'

import type { Settings } from '../types'
import { C, k, mins, money, type Data, type UI } from './kit'
import { sessionUsd } from './ledger'

export const FIVE_HOURS_MS = 5 * 3_600_000
// Main-thread cache: the pop-up comes when the clock turns orange (70 % of the lifetime gone: 18 of 60 min left, 1.5 of 5)
export const warnMinutes = (ttlMin: number) => ttlMin * 0.3

// Per-session values the band needs beyond the ledger, kept in the store so a hot reload keeps them
export type LineState = {
  growth: number[]                 // context change of the last three main turns, oldest first
  lastCtx: number | null           // context tokens after the previous main turn
  hit: number | null               // cache hit % of the last main turn
  turns: number
  compactions: number
  compacted: { after: number | null } | null
}
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type UsageView = { context?: { tokens?: number | null; window?: number; percent?: number | null }; rateLimits?: Limit[]; cost?: { usd?: number } } | null

export const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
export const ctxTokens = (usage: UsageView) => (usage && usage.context && num(usage.context.tokens) ? usage.context.tokens : null)
export const limitOf = (usage: UsageView, kind: string) => ((usage && usage.rateLimits) || []).find(r => r && r.kind === kind && num(r.percentUsed))
export const resetMs = (l: Limit | undefined) => {
  const t = l && l.resetsAt ? new Date(l.resetsAt).getTime() : NaN
  return num(t) ? t : null
}
// What the last turn added, the same look for Context and Session: " (↑30k)", " (↓12k)"
export const grown = (value: string, isDown = false) => ' (' + (isDown ? '↓' : '↑') + value + ')'

// head: the Report button, pinned at the band's left edge
export type LineInput = { d: Data; settings: Settings; isWorking: boolean; head?: RenderElement; frame?: number
  // The one action the band offers once the context reaches the threshold
  onCompact?: () => void }

// One colour rule: the share of a limit already used, steps at 70 % and 90 %. Session metrics
// (Context, Cache, Session) show green when fine; long-term ones (Weekly) stay colourless until orange.
export const WARN_SHARE = 0.7, RED_SHARE = 0.9
export function stateColor(share: number, isSessionMetric: boolean): string | null {
  if (!num(share)) return null
  if (share >= RED_SHARE) return C.red
  if (share >= WARN_SHARE) return C.warn
  return isSessionMetric ? C.ok : null
}

// The 5-hour window by pace: what this pace reaches by the reset. Under 90 % green, 90–110 % orange,
// over 110 % red; colourless in the first 30 min (too little to tell); 90 % actually used is red
// whatever the pace. Null = no reading yet.
export const PACE_MIN_MS = 30 * 60_000
export function paceColor(percentUsed: number, leftMs: number | null): string | null {
  if (percentUsed >= 90) return C.red
  if (leftMs === null) return null
  const elapsed = FIVE_HOURS_MS - leftMs
  if (elapsed < PACE_MIN_MS) return null
  const projected = (percentUsed / elapsed) * FIVE_HOURS_MS
  return projected >= 110 ? C.red : projected >= 90 ? C.warn : C.ok
}

export function drawLine(ui: UI, o: LineInput): RenderElement {
  const { Box, Text, Button } = ui
  const { d, settings } = o
  const dim = (s: string, key: string) => <Text key={key} dimColor>{s}</Text>
  const col = (s: string, color: string | null, key: string) => (color ? <Text key={key} color={color}>{s}</Text> : <Text key={key}>{s}</Text>)
  const parts: RenderElement[][] = []
  const tokens = ctxTokens(d.usage)
  const target = d.target

  // Context: size and what the last turn added, coloured against the threshold; Compact once past it
  {
    const p: RenderElement[] = [dim('Context: ', 'c-l')]
    if (d.s.compacted) {
      p.push(dim(num(d.s.compacted.after) ? '~' + k(d.s.compacted.after) + ' compacted' : 'compacted', 'c-v'))
    } else if (tokens === null) {
      p.push(dim('–', 'c-v'))
    } else {
      const growth = d.s.growth.filter(num)
      const last = growth[growth.length - 1]
      p.push(col(k(tokens), target ? stateColor(tokens / target, true) : C.ok, 'c-v'), dim(last !== undefined ? grown(k(Math.abs(last)), last < 0) : '', 'c-g'))
      if (target && tokens >= target && o.onCompact && !o.isWorking && settings.atTarget !== 'off') {
        p.push(dim('  ', 'c-gap'), <Button key="c-compact" label="⤓" variant="primary" onPress={o.onCompact} />)
      }
    }
    parts.push(p)
  }

  // Cache: the main thread's clock in its real lifetime (5 min on an API key, 60 on a plan)
  {
    const p: RenderElement[] = [dim('Cache: ', 'k-l')]
    const left = d.cacheLeft
    if (o.isWorking) {
      // While a turn runs the cache is being refreshed: a spinner (a frame every 350 ms)
      p.push(<Text key="w-s" color={C.ok}>{'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[(o.frame ?? 0) % 10]! + ' working'}</Text>)
    } else if (d.s.compacted || (left !== null && left <= 0)) {
      const price = d.rewriteUsd !== null ? ' · next send rewrites ' + k(d.s.compacted?.after ?? tokens) + ' ' + money(d.rewriteUsd, settings, d.s.compacted ? '~' : '≈') : ''
      p.push(col('cold' + (d.s.compacted ? ' · compacted' : '') + price, C.red, 'k-v'))
    } else if (left === null) {
      p.push(dim('– no request yet', 'k-v'))
    } else {
      p.push(col(mins(left), stateColor(1 - left / d.ttlMin, true) ?? C.ok, 'k-v'))
    }
    parts.push(p)
  }

  // Session: the total so far, and in brackets what the last turn added (main thread and its agents)
  {
    const total = sessionUsd(d.L, d.usage?.cost?.usd)
    const p: RenderElement[] = [dim('Session: ', 'm-l'), col(money(total, settings), C.ok, 'm-v')]
    const last = d.series[d.series.length - 1]
    if (last) p.push(dim(grown(money(last.usd, settings, '')), 'm-t'))
    parts.push(p)
  }

  // Plan limits: only on a subscription. "5h: 35% ↻ 1h 54m (14:30)"
  if (d.billing.billing !== 'api') {
    const five = limitOf(d.usage, 'five_hour'), week = limitOf(d.usage, 'seven_day')
    if (five) {
      const reset = resetMs(five)
      const p: RenderElement[] = [dim('5h: ', 'f-l'), col(Math.round(five.percentUsed) + '%', paceColor(five.percentUsed, reset === null ? null : Math.max(0, reset - d.now)), 'f-v')]
      if (reset !== null) {
        const left = Math.max(0, reset - d.now)
        const at = new Date(reset).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
        p.push(dim(' ↻ ' + mins(left / 60_000) + ' (' + at + ')', 'f-r'))
      }
      parts.push(p)
    }
    if (week) parts.push([dim('Weekly: ', 'w-l'), col(Math.round(week.percentUsed) + '%', stateColor(week.percentUsed / 100, false), 'w-v')])
  }

  // Each segment is one box with equal space around it; thin bars between
  const run: RenderElement[] = []
  parts.forEach((p, i) => {
    if (i) run.push(dim(' │ ', 'sep-' + i))
    run.push(<Box key={'seg-' + i} flexDirection="row">{p}</Box>)
  })
  const body = <Box key="body" flexDirection="row" flexWrap="wrap" alignItems="center" flexGrow={1} justifyContent="space-evenly">{run}</Box>
  return (
    <Box flexDirection="row" alignItems="center" borderStyle="round" borderDimColor paddingX={1}>
      {o.head ? [o.head, dim(' ', 'head-gap'), body] : [body]}
    </Box>
  )
}

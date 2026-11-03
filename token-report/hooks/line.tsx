// The band above the prompt. Draws only; every number comes from Data (ledger + engine usage).
//   [≣ Report]  Context: 184k (↑38k) [⤓] │ Cache: 52m │ Session: ≈ 3.82 € (↑0.21 €) │ 5h: 64% ↻ 1h 50m (14:30) │ Weekly: 81%
// Narrow, it drops what it can spare to stay on one line:  [≣ Report]  184k [⤓] │ 52m │ ≈ 3.82 € │ 64% ↻ 1h 50m
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
  onCompact?: () => void
  // The band's width in character cells (AbovePrompt's bodyColumns): past it the segments wrap by whole lines
  columns?: number }

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

// How much the band shows. It stays on one line as long as it can: first the extras go (what the last
// turn added, the reset's clock time, the cold price's wording), then the labels, then Weekly. Only if
// even that does not fit do whole segments wrap onto a second line.
const FULL = 0, NO_EXTRAS = 1, NO_LABELS = 2, NO_WEEKLY = 3

export function drawLine(ui: UI, o: LineInput): RenderElement {
  const { Box, Text, Button } = ui
  const { d, settings } = o
  const tokens = ctxTokens(d.usage)
  const target = d.target

  // The segments at one level, each with its width in cells (counted as it is built)
  const build = (level: number) => {
    let width = 0
    const dim = (s: string, key: string) => { width += s.length; return <Text key={key} dimColor>{s}</Text> }
    const col = (s: string, color: string | null, key: string) => { width += s.length; return color ? <Text key={key} color={color}>{s}</Text> : <Text key={key}>{s}</Text> }
    const label = (s: string, key: string) => (level < NO_LABELS ? [dim(s + ': ', key)] : [])
    const parts: RenderElement[][] = []
    const widths: number[] = []
    const push = (p: RenderElement[]) => { parts.push(p); widths.push(width); width = 0 }

    // Context: size and what the last turn added, coloured against the threshold; Compact once past it
    {
      const p: RenderElement[] = label('Context', 'c-l')
      if (d.s.compacted) {
        p.push(dim(num(d.s.compacted.after) ? '~' + k(d.s.compacted.after) + ' compacted' : 'compacted', 'c-v'))
      } else if (tokens === null) {
        p.push(dim('–', 'c-v'))
      } else {
        const growth = d.s.growth.filter(num)
        const last = growth[growth.length - 1]
        p.push(col(k(tokens), target ? stateColor(tokens / target, true) : C.ok, 'c-v'))
        if (level < NO_EXTRAS && last !== undefined) p.push(dim(grown(k(Math.abs(last)), last < 0), 'c-g'))
        if (target && tokens >= target && o.onCompact && !o.isWorking && settings.atTarget !== 'off') {
          width += 4
          p.push(dim('  ', 'c-gap'), <Button key="c-compact" label="⤓" variant="primary" onPress={o.onCompact} />)
        }
      }
      push(p)
    }

    // Cache: the main thread's clock in its real lifetime (5 min on an API key, 60 on a plan)
    {
      const p: RenderElement[] = label('Cache', 'k-l')
      const left = d.cacheLeft
      if (o.isWorking) {
        // While a turn runs the cache is being refreshed: a spinner (a frame every 350 ms)
        p.push(col('⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[(o.frame ?? 0) % 10]! + ' working', C.ok, 'w-s'))
      } else if (d.s.compacted || (left !== null && left <= 0)) {
        const mark = d.s.compacted ? '~' : '≈'
        const price = d.rewriteUsd === null ? ''
          : level < NO_EXTRAS ? ' · next send rewrites ' + k(d.s.compacted?.after ?? tokens) + ' ' + money(d.rewriteUsd, settings, mark)
          : ' ' + money(d.rewriteUsd, settings, mark)
        p.push(col('cold' + (d.s.compacted && level < NO_EXTRAS ? ' · compacted' : '') + price, C.red, 'k-v'))
      } else if (left === null) {
        p.push(dim(level < NO_EXTRAS ? '– no request yet' : '–', 'k-v'))
      } else {
        p.push(col(mins(left), stateColor(1 - left / d.ttlMin, true) ?? C.ok, 'k-v'))
      }
      push(p)
    }

    // Session: the total so far, and in brackets what the last turn added (main thread and its agents)
    {
      const total = sessionUsd(d.L, d.usage?.cost?.usd)
      const p: RenderElement[] = [...label('Session', 'm-l'), col(money(total, settings), C.ok, 'm-v')]
      const last = d.series[d.series.length - 1]
      if (last && level < NO_EXTRAS) p.push(dim(grown(money(last.usd, settings, '')), 'm-t'))
      push(p)
    }

    // Plan limits: only on a subscription. "5h: 35% ↻ 1h 54m (14:30)"
    if (d.billing.billing !== 'api') {
      const five = limitOf(d.usage, 'five_hour'), week = limitOf(d.usage, 'seven_day')
      if (five) {
        const reset = resetMs(five)
        const p: RenderElement[] = [...label('5h', 'f-l'), col(Math.round(five.percentUsed) + '%', paceColor(five.percentUsed, reset === null ? null : Math.max(0, reset - d.now)), 'f-v')]
        if (reset !== null) {
          const left = Math.max(0, reset - d.now)
          const at = new Date(reset).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
          p.push(dim(' ↻ ' + mins(left / 60_000) + (level < NO_EXTRAS ? ' (' + at + ')' : ''), 'f-r'))
        }
        push(p)
      }
      if (week && level < NO_WEEKLY) push([...label('Weekly', 'w-l'), col(Math.round(week.percentUsed) + '%', stateColor(week.percentUsed / 100, false), 'w-v')])
    }
    return { parts, widths }
  }

  // The Report button, its gap and the frame take about 16 cells
  const SEP = ' │ '
  const room = (o.columns ?? Infinity) - 16
  const oneLine = (w: number[]) => w.reduce((a, b) => a + b, 0) + SEP.length * Math.max(0, w.length - 1)
  let level = FULL
  let built = build(level)
  while (level < NO_WEEKLY && oneLine(built.widths) > room) built = build(++level)
  const { parts, widths } = built

  // Still too wide: whole segments wrap by line, the bars only between segments of one line
  const lines: number[][] = []
  let used = 0
  widths.forEach((w, i) => {
    const line = lines[lines.length - 1]
    if (line && used + SEP.length + w <= room) {
      line.push(i)
      used += SEP.length + w
    } else {
      lines.push([i])
      used = w
    }
  })
  const row = (idx: number[], n: number) => {
    const run: RenderElement[] = []
    idx.forEach((i, j) => {
      if (j) run.push(<Text key={'sep-' + i} dimColor>{SEP}</Text>)
      run.push(<Box key={'seg-' + i} flexDirection="row">{parts[i]}</Box>)
    })
    // One line: equal space around the segments. Several: each line starts at the left edge
    return <Box key={'line-' + n} flexDirection="row" alignItems="center" justifyContent={lines.length > 1 ? 'flex-start' : 'space-evenly'} flexGrow={1}>{run}</Box>
  }
  const body = lines.length > 1
    ? <Box key="body" flexDirection="column" flexGrow={1}>{lines.map(row)}</Box>
    : row(lines[0] ?? [], 0)
  return (
    <Box flexDirection="row" alignItems="center" borderStyle="round" borderDimColor paddingX={1}>
      {o.head ? [o.head, <Text key="head-gap"> </Text>, body] : [body]}
    </Box>
  )
}

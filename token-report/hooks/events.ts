// token-report event log: one JSON object per line in <folder>/events-YYYY-MM.jsonl (the month of the
// event, UTC), for readers outside the mod (a cost dashboard). Off unless the mod's option
// `eventLogFolder` names a folder; off, the mod does exactly what it did without it. Format: BUILD.md
// § Event log. Ids and numbers only: no titles, prompts or paths.
//
// $.fs has no append: the month's file is read and written back with the new lines at its end, one
// write at a time. Other sessions write the same file, so a line of ours that another session's write
// dropped is put back with the next write. Logging never throws, never waits in a hook's way and
// says nothing in the UI.
import type { EngineInterface } from 'claude-code'

export type Row = Record<string, string | number | boolean | null>

// $.fs.read rejects a file over 4 MiB: from 3 MB on, the month goes on in events-YYYY-MM.2.jsonl (.3, …)
const PART_CHARS = 3_000_000
const MAX_PARTS = 50
// Our own last lines per file, checked on each write
const KEEP_OWN = 40

// The folder as the option gives it ('' = off), and the same with a leading ~ resolved
let folder = ''
let dir = ''
let queue: { month: string; line: string }[] = []
let chain: Promise<void> = Promise.resolve()
let part: Record<string, number> = {}
let own: { file: string; line: string }[] = []

const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
const slash = (p: string) => p.split('\\').join('/')
export const usd6 = (n: number) => Math.round(n * 1e6) / 1e6

// A new session (or a reload): the folder as the option has it now, nothing remembered about files
// written before
export function startEventLog(option: unknown) {
  folder = typeof option === 'string' ? slash(option.trim()).replace(/\/+$/, '') : ''
  dir = ''
  queue = []
  part = {}
  own = []
}
export const isEventLogOn = () => folder !== ''

// Resolves once everything queued so far is written (or given up on)
export const eventsIdle = () => chain

export function logEvent($: EngineInterface, session: string, kind: string, at: number, fields: Row = {}): Promise<void> {
  if (!folder) return chain
  try {
    const ts = new Date(at).toISOString()
    queue.push({ month: ts.slice(0, 7), line: JSON.stringify({ ts, session, kind, ...fields }) })
    chain = chain.then(() => flush($)).catch(() => undefined)
  } catch { /* a bad time or value: no line */ }
  return chain
}

async function flush($: EngineInterface) {
  if (!queue.length) return
  const batch = queue
  queue = []
  if (!dir) {
    const isHome = folder.startsWith('~')
    const home = isHome ? slash(String((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '')) : ''
    if (isHome && !home) return
    dir = isHome ? home + folder.slice(1) : folder
  }
  for (const month of [...new Set(batch.map(b => b.month))]) {
    try {
      await append($, month, batch.filter(b => b.month === month).map(b => b.line))
    } catch { /* this month's lines are lost; the next batch tries afresh */ }
  }
}

async function append($: EngineInterface, month: string, lines: string[]) {
  for (let n = part[month] ?? 1; n <= MAX_PARTS; n++) {
    const file = dir + '/events-' + month + (n > 1 ? '.' + n : '') + '.jsonl'
    let old = ''
    if (await $.fs.exists(file)) {
      // A file that is there but can't be read (too big, locked) is never written over
      try { old = await $.fs.read(file) } catch { continue }
      if (old.length > PART_CHARS) continue
    }
    part[month] = n
    const lost = own.filter(o => o.file === file && !old.includes(o.line)).map(o => o.line)
    const head = old && !old.endsWith('\n') ? old + '\n' : old
    await $.fs.write(file, head + [...lost, ...lines].join('\n') + '\n')
    own = [...own, ...lines.map(line => ({ file, line }))].slice(-KEEP_OWN)
    return
  }
}

// ---- limit samples ----------------------------------------------------------------------------------
// One row per limit window whose percent or reset time differs from the last row written for it in
// this session. Every kind the app reports is taken, whatever its name. `seen` maps a kind to what was
// last written; the caller keeps the returned one (and stores it, so a reload writes no duplicates).
// Two sources, kept apart by `source`: 'engine' is what the mod API reports ($.session.usage: `kind`),
// 'app' the desktop app's usage card (planOf below: `label`, which also has per-model weekly windows).
// A name is passed through as it arrives. The reset time is rounded to the minute: the app's wobbles
// by milliseconds from call to call.
export function limitRows(limits: unknown, seen: Record<string, string>, source: 'engine' | 'app' = 'engine'): { rows: Row[]; seen: Record<string, string> } {
  const rows: Row[] = []
  const next = { ...seen }
  for (const l of Array.isArray(limits) ? limits : []) {
    const name = l && (typeof l.kind === 'string' ? l.kind : typeof l.label === 'string' ? l.label : '')
    if (!name || !num(l.percentUsed)) continue
    const at = typeof l.resetsAt === 'string' ? Date.parse(l.resetsAt) : NaN
    const resetsAt = num(at) ? new Date(Math.round(at / 60_000) * 60_000).toISOString() : null
    const key = limitKey(name, source)
    const sig = l.percentUsed + '|' + (resetsAt ?? '')
    if (next[key] === sig) continue
    next[key] = sig
    rows.push({ limit: name, percent_used: l.percentUsed, resets_at: resetsAt, source })
  }
  return { rows, seen: next }
}

export const limitKey = (name: string, source: 'engine' | 'app') => (source === 'engine' ? name : source + ':' + name)

// ---- early resets -----------------------------------------------------------------------------------
// A window whose percent fell although its last known reset time is still ahead: someone reset the
// limit early (a plan action in the Claude app). One `limit_reset` row per window and source for such
// a drop, besides the normal `limit` row. Compared with what limitRows last wrote (`seen`, before it is
// updated), so the same drop is never written twice by this session, also across reloads (seen is
// stored). `noted` is shared by all sessions ($.store): a drop another session noted after this
// session's last reading of that window (`seenAt`) is the same reset and writes nothing here.
// Not a reset: the ordinary roll-over at the reset time (within RESET_MARGIN_MS of it, the reset time
// being rounded to the minute) and a fall of one point with the reset time unchanged (rounding wobble).
export type ResetNote = Record<string, { from: string; at: number }>
export const RESET_MARGIN_MS = 5 * 60_000
export function resetRows(limits: unknown, seen: Record<string, string>, seenAt: Record<string, number>, noted: ResetNote, now: number, source: 'engine' | 'app' = 'engine'): { rows: Row[]; noted: ResetNote } {
  const rows: Row[] = []
  const next = { ...noted }
  for (const l of Array.isArray(limits) ? limits : []) {
    const name = l && (typeof l.kind === 'string' ? l.kind : typeof l.label === 'string' ? l.label : '')
    if (!name || !num(l.percentUsed)) continue
    const key = limitKey(name, source)
    const [p, from] = (seen[key] ?? '').split('|')
    const before = p ? Number(p) : NaN
    const fromMs = from ? Date.parse(from) : NaN
    if (!num(before) || !num(fromMs) || fromMs - now <= RESET_MARGIN_MS || l.percentUsed >= before) continue
    const at = typeof l.resetsAt === 'string' ? Date.parse(l.resetsAt) : NaN
    const to = num(at) ? new Date(Math.round(at / 60_000) * 60_000).toISOString() : null
    if (before - l.percentUsed < 2 && to === from) continue
    const n = next[key]
    if (n && n.from === from && n.at >= (seenAt[key] ?? 0)) continue
    next[key] = { from, at: now }
    rows.push({ limit: name, percent_before: before, percent_after: l.percentUsed, resets_at_before: from, resets_at_after: to, source })
  }
  return { rows, noted: next }
}

// What the desktop app's usage tool (mcp__ccd_session_mgmt__get_usage) answered, as a mod's
// $.tool.call returns it: the plan part, or null when the call was denied, failed or said nothing usable
export function planOf(answer: unknown): { status: string; windows: unknown[] } | null {
  const r = answer as { deny?: unknown; isError?: unknown; result?: unknown; text?: unknown } | null
  if (!r || typeof r !== 'object' || r.deny || r.isError) return null
  for (const v of [r.result, r.text]) {
    try {
      const body = (typeof v === 'string' ? JSON.parse(v) : v) as { plan?: { status?: unknown; windows?: unknown } } | null
      const plan = body && typeof body === 'object' ? body.plan : null
      if (plan && typeof plan.status === 'string') return { status: plan.status, windows: Array.isArray(plan.windows) ? plan.windows : [] }
    } catch { /* not JSON: try the other field */ }
  }
  return null
}

// token-report router (v2 slice 2, plan/v2-slice2-router.md): the rules for agent and session starts.
// Pure functions over plain data, like ledger.ts: register.tsx asks them and acts. Nothing here touches
// `$`, and nothing returned carries prompt text (only hashes, numbers and fixed wording).
import { priceFor } from './ledger'

// ---- Is a start research or gathering? (spec § 3) ------------------------------------------------
export type Cls = 'gather' | 'other'
export type Signal = 'type' | 'words' | null

// Read-only search, docs lookup, wrappers that start another model and wait
const GATHER_TYPES = new Set(['explore', 'claude-code-guide', 'gpt', 'gpt-review'])
const OTHER_TYPES = new Set(['plan', 'fork'])
// Phrases that mark gathering and would otherwise hit a build word ("edit", "change")
const NEGATED = /\b(do not|don't|dont|never|without|no) (edit|editing|edits|change|changes|modify|modifying)\b|\bread[- ]only\b/g
// Build or review words: these win over gathering words
const BUILD = /(?<![a-z])(implement|fix|refactor|edit|build|write code|write tests|commit|migrat|debug|bug|review|audit|critique|judge|rank|verif|prüf|kritik|gegenles|bewert|umsetz|bau)/
const GATHER = /(?<![a-z])(research|recherch|search|suche|durchsuch|look up|lookup|find|gather|collect|sammel|extract|fetch|brows|scrape|crawl|survey|dossier|sources|quellen|list all|summari|read[- ]only|do not edit|don't edit|report back)/
const WRAPPER = /(?<![a-z])(route|codex|gpt|astra)(?![a-z])/

export function classifyStart(type: string | undefined, description: string | undefined, prompt: string | undefined): { cls: Cls; signal: Signal } {
  // A plugin's agent is `<plugin>:<name>`: the name decides
  const t = String(type || '').toLowerCase().split(':').pop() || ''
  if (GATHER_TYPES.has(t)) return { cls: 'gather', signal: 'type' }
  if (OTHER_TYPES.has(t) || /review|verif|test/.test(t)) return { cls: 'other', signal: 'type' }
  const desc = String(description || '').toLowerCase()
  const text = (desc + ' ' + String(prompt || '').slice(0, 600)).toLowerCase()
  if (BUILD.test(text.replace(NEGATED, ' '))) return { cls: 'other', signal: null }
  if (GATHER.test(text) || WRAPPER.test(desc)) return { cls: 'gather', signal: 'words' }
  return { cls: 'other', signal: null }
}

// ---- Matched jobs (spec § 5) --------------------------------------------------------------------
// The same job on another model: the prompt with model names blanked, case and spacing evened out,
// as an FNV-1a 32-bit hash. Never the text itself.
export function jobKey(prompt: string | undefined): string {
  const norm = String(prompt || '').toLowerCase()
    .replace(/claude-[a-z]+-\d+(-\d+)*/g, ' ')
    .replace(/\b(opus|sonnet|haiku|fable)\b/g, ' ')
    .replace(/\s+/g, ' ').trim()
  let h = 0x811c9dc5
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ---- Prices (from ledger.ts's table, never a copy of it) ----------------------------------------
// Expensive = list input from $4 per million: Opus 5.5 and Fable 5.1, never Sonnet or Haiku
export const EXPENSIVE_INPUT = 4
export const SUGGESTED = 'sonnet'
export const isExpensive = (model: string | null | undefined) => !!model && priceFor(model).input >= EXPENSIVE_INPUT
// Sonnet's price per token against the parent's, list input, two decimals
export const ratioTo = (parent: string) => Math.round((priceFor(SUGGESTED).input / priceFor(parent).input) * 100) / 100
// Same tier by price (an alias and a full id of one model count as the same)
export const samePrice = (a: string, b: string) => priceFor(a).input === priceFor(b).input
// What a gathering agent typically costs on Opus or Fable: assumed, near the waste study's M3 mean
// (research 2.3 €, wrappers 1.0 €, other 1.3 €). Replace with the median of agent_end lines.
export const GATHER_TYPICAL_USD = 1.0
// A fresh session start carries about this much (the study's M3 median); a fork above it carries more
export const FRESH_SETUP = 85_000
export const FORK_CARRY_USD = 0.25

// What the hand-back itself costs: the caller's next request at its context, read from a warm cache or
// written again to a cold one, plus a short answer
export function roundTripUsd(tokens: number, parent: string, isCold: boolean, ttlMin: number): number {
  const p = priceFor(parent, tokens)
  const prompt = isCold ? (ttlMin >= 60 ? p.write1h : p.write5m) : p.cacheRead
  return (tokens * prompt + 1_000 * p.output) / 1e6
}
export const savingUsd = (parent: string) => (1 - ratioTo(parent)) * GATHER_TYPICAL_USD
export const amountMatters = (tokens: number, parent: string, isCold: boolean, ttlMin: number) =>
  savingUsd(parent) > roundTripUsd(tokens, parent, isCold, ttlMin)

// What a fork loads beyond a fresh start, written to the 1 h cache on the parent's model
export const forkCarryUsd = (tokens: number, parent: string) =>
  (Math.max(0, tokens - FRESH_SETUP) * priceFor(parent, tokens).write1h) / 1e6
export const forkGuardFires = (tokens: number, parent: string, isCold: boolean) =>
  forkCarryUsd(tokens, parent) >= FORK_CARRY_USD || (isCold && tokens > FRESH_SETUP)

// ---- The caller's answer to a hand-back ---------------------------------------------------------
export type Answer = 'cheaper' | 'same_model' | 'other_model' | 'fresh' | 'fork_again' | 'dropped'
export function answerOf(named: string, parent: string): Answer {
  if (!named || samePrice(named, parent)) return 'same_model'
  return priceFor(named).input < priceFor(parent).input ? 'cheaper' : 'other_model'
}

// ---- What a subagent did (agent_end) -------------------------------------------------------------
export type ToolKind = 'web' | 'browser' | 'read' | 'write' | 'other'
export function toolKind(name: string): ToolKind {
  if (name === 'WebFetch' || name === 'WebSearch') return 'web'
  if (/browser|chrome|playwright|pw-/i.test(name)) return 'browser'
  if (name === 'Read' || name === 'Grep' || name === 'Glob' || name === 'LS') return 'read'
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit' || name === 'MultiEdit') return 'write'
  return 'other'
}

// ---- The session tools' result text (spike § 1) --------------------------------------------------
export function startResult(r: unknown): { result: 'started' | 'proposed' | 'refused'; child: string | null } {
  const o = (r || {}) as { isError?: unknown; text?: unknown; result?: unknown }
  if (o.isError) return { result: 'refused', child: null }
  let text = typeof o.text === 'string' ? o.text : ''
  if (!text) try { text = typeof o.result === 'string' ? o.result : JSON.stringify(o.result ?? '') } catch { text = '' }
  const child = /session_id:\s*(local_[0-9a-f-]+)/i.exec(text)?.[1]
  if (child) return { result: 'started', child }
  const task = /task_id:\s*(task_[0-9a-f]+)/i.exec(text)?.[1]
  return task ? { result: 'proposed', child: task } : { result: 'started', child: null }
}

// ---- Wording (spec § 4) ----------------------------------------------------------------------
// `claude-opus-5-5` → `Opus 5.5`; an alias or unknown id as it came
export function modelName(id: string): string {
  const m = /claude-([a-z]+)-(\d+)-(\d+)/i.exec(id)
  if (m) return m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1) + ' ' + m[2] + '.' + m[3]
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : 'the caller\'s model'
}
const SIGNAL_TEXT: Record<string, string> = { type: 'by its agent type', words: 'by its description' }

export const handBackAgent = (signal: Signal, parent: string) =>
  'Token Report (Managed): this agent was not started. It looks like research or gathering (' + (SIGNAL_TEXT[signal ?? ''] ?? 'by its description') +
  '), and with no model named it would run on ' + modelName(parent) + ', the caller\'s model. Sonnet costs about ' + ratioTo(parent) +
  '× as much per token. Call Agent again with the same input plus model: "sonnet". If the task needs ' + modelName(parent) +
  '\'s judgment, call again naming that model; a call that names a model always starts.'

export const noteExplicit = (model: string) =>
  'Token Report: this research or gathering agent runs on ' + modelName(model) + ' by explicit choice. Sonnet costs about ' + ratioTo(model) +
  '× as much per token, and in this account\'s matched jobs it used no more tokens. For similar agents name sonnet unless they need ' +
  modelName(model) + '\'s judgment.'

export const handBackFork = (tokens: number, parent: string, isHandOff: boolean) =>
  'Token Report (Managed): not started. ' + (isHandOff ? 'A hand-off' : 'context: "fork"') + ' copies this conversation (' + Math.round(tokens / 1000) +
  'k tokens, about $' + forkCarryUsd(tokens, parent).toFixed(2) + ' to load at ' + modelName(parent) + ' list price) into the new session. ' +
  (isHandOff ? 'Use start_session with context: "fresh"' : 'Call again with context: "fresh"') +
  ' and a brief that names the files, the decisions so far and what done looks like. If the task needs this whole conversation, call again unchanged; a repeated ' +
  (isHandOff ? 'hand-off' : 'fork') + ' passes.'

export const handBackModel = (parent: string) =>
  'Token Report (Managed): not started. No model is named, so the new session would run on ' + modelName(parent) +
  ' like this one. Name the model the task needs: "claude-sonnet-5-5" for gathering, reading or routine edits, the current model if it builds or decides. ' +
  'Then call again; a call that names a model always passes.'

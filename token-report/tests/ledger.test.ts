// Ledger maths: prices, requests, rewrites, clocks, snapshots, and how money reads.
import { test, expect } from 'claude-code/testing'
import {
  priceFor, PRICE_STAND, partsOf, sumParts, newLedger, addRequest, isRewrite, clockLeft, ledgerUsd,
  noteAgentStart, noteAgentEnd, snapshot, restore, type Ttl, type Usage,
} from '../hooks/ledger'
import { money } from '../hooks/kit'

const close = (a: number | null | undefined, b: number) => expect(typeof a === 'number' && Math.abs(a - b) < 1e-9).toBe(true)
const u = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({ input, cacheRead, cacheWrite, output })
const usdOf = (x: Usage, model: string, ttl: Ttl) => sumParts(partsOf(x, model, ttl))

test('prices: list prices per model, Haiku 5.5 tier above 100k, unknown falls back to Opus 5.5', () => {
  expect(priceFor('claude-opus-5-5').input).toBe(4)
  expect(priceFor('claude-opus-5-5[1m]').write1h).toBe(8)
  expect(priceFor('claude-sonnet-5-5').write5m).toBe(2.5)
  expect(priceFor('claude-haiku-5-5', 50_000).input).toBe(0.1)
  expect(priceFor('claude-haiku-5-5', 150_000).input).toBe(0.5)
  close(priceFor('claude-haiku-5-5', 150_000).cacheRead, 0.05)
  expect(priceFor('something-new').input).toBe(4)
})

test('prices: the table loads from prices.json and prices one known request', () => {
  expect(PRICE_STAND).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  // Opus 5.5, 1h cache: 1k input × 4 + 100k read × 0.20 + 10k write × 8 + 2k output × 20 = 0.144 $
  close(usdOf(u(1_000, 100_000, 10_000, 2_000), 'claude-opus-5-5', '1h'), 0.144)
  // longest key wins: Opus 5 is not Opus 5.5, Fable 5.2 is not Fable 5.1
  expect(priceFor('claude-opus-5').input).toBe(5)
  expect(priceFor('claude-fable-5-2').cacheRead).toBe(0.2)
  expect(priceFor('claude-sonnet-4-6').cacheRead).toBe(0.3)
})

test('prices: an unknown id takes its family, only a nameless one Opus 5.5', () => {
  expect(priceFor('claude-sonnet-9').cacheRead).toBe(priceFor('claude-sonnet-5-5').cacheRead)
  expect(priceFor('us.anthropic.claude-haiku-9').input).toBe(priceFor('claude-haiku-5-5').input)
  expect(priceFor('claude-fable-5').output).toBe(priceFor('claude-fable-5-1').output)
  expect(priceFor('some-gateway-model').input).toBe(priceFor('claude-opus-5-5').input)
})

test('usd: tokens × price, cache writes at the TTL rate', () => {
  // 1M cache writes on Opus: 8 $ at 1h, 5 $ at 5m
  close(usdOf(u(0, 0, 1_000_000, 0), 'claude-opus-5-5', '1h'), 8)
  close(usdOf(u(0, 0, 1_000_000, 0), 'claude-opus-5-5', '5m'), 5)
  close(usdOf(u(1_000_000, 1_000_000, 0, 1_000_000), 'claude-opus-5-5', '1h'), 4 + 0.2 + 20)
})

test('money: the € sign after the amount, $ before it, non-breaking spaces, small amounts honest', () => {
  const eur = { currency: 'eur' as const, eurRate: 1 }
  // Non-breaking spaces: a narrow pane never splits the amount from € or ≈
  expect(money(1.123, eur)).toBe('≈ 1.12 €')
  expect(money(0.04, eur, '~')).toBe('~ 0.04 €')
  expect(money(0.001, eur)).toBe('< 0.01 €')
  expect(money(NaN, eur)).toBe('–')
  expect(money(1.3, { currency: 'usd', eurRate: 1 }, '')).toBe('$1.30')
})

test('requests: totals, rewrites, per-agent first request and last tool', () => {
  const L = newLedger('s', 0, 1)
  addRequest(L, { turnId: 't', index: 0, agentId: null, model: 'claude-opus-5-5', startedAt: 1000, endedAt: 2000, usage: u(10, 100_000, 2_000, 500), tools: ['Read'] }, 60, 5)
  addRequest(L, { turnId: 't', index: 1, agentId: null, model: 'claude-opus-5-5', startedAt: 3000, endedAt: 4000, usage: u(10, 0, 160_000, 100), tools: [] }, 60, 5)
  expect(L.main.lastRequestAt).toBe(3000)
  expect(L.main.rewrites.count).toBe(1)
  expect(L.main.rewrites.tokens).toBe(160_000)
  noteAgentStart(L, 'a1', { description: 'Read the docs', type: 'Explore', model: 'claude-haiku-5-5', at: 5000 })
  addRequest(L, { turnId: 'x', index: 0, agentId: 'a1', model: 'claude-haiku-5-5', startedAt: 5000, endedAt: 6000, usage: u(2, 0, 28_000, 40), tools: ['Grep', 'Read'] }, 60, 5)
  addRequest(L, { turnId: 'x', index: 1, agentId: 'a1', model: 'claude-haiku-5-5', startedAt: 7000, endedAt: 8000, usage: u(2, 28_000, 3_000, 40), tools: ['Read'] }, 60, 5)
  const a = L.agents.a1!
  expect(a.first).toEqual({ read: 0, wrote: 28_000 })
  expect(a.lastTool).toBe('Read')
  expect(a.lastRequestAt).toBe(7000)
  expect(a.requests).toBe(2)
  // sub-agent writes priced at 5m
  close(a.usd, usdOf(u(2, 0, 28_000, 40), 'claude-haiku-5-5', '5m') + usdOf(u(2, 28_000, 3_000, 40), 'claude-haiku-5-5', '5m'))
  close(ledgerUsd(L), L.main.usd + a.usd)
  noteAgentEnd(L, 'a1', 9000)
  expect(L.agents.a1!.endedAt).toBe(9000)
})

test('requests: an unknown agent id is a partial workflow agent', () => {
  const L = newLedger('s', 0, 0)
  addRequest(L, { turnId: 'w', index: 0, agentId: 'wf9', model: 'claude-sonnet-5-5', startedAt: 1, endedAt: 2, usage: u(1, 0, 0, 1), tools: [] }, 60, 5)
  expect(L.agents.wf9!.workflow).toBe(true)
})

test('requests: bounded, older ones folded into totals', () => {
  const L = newLedger('s', 0, 0)
  for (let i = 0; i < 2100; i++) addRequest(L, { turnId: 't' + i, index: 0, agentId: null, model: 'claude-opus-5-5', startedAt: i, endedAt: i, usage: u(1000, 0, 0, 0), tools: [] }, 60, 5)
  expect(L.requests.length).toBe(2000)
  expect(L.folded.n).toBe(100)
  close(ledgerUsd(L), 2100 * 1000 * 4 / 1e6)
})

test('rewrite rule and cache clock', () => {
  expect(isRewrite(u(0, 10_000, 30_000, 0))).toBe(true)
  expect(isRewrite(u(0, 100_000, 30_000, 0))).toBe(false)
  expect(isRewrite(u(0, 0, 10_000, 0))).toBe(false)
  expect(clockLeft(0, 60, 1000)).toBe(null)
  close(clockLeft(60_000, 60, 60_000 + 30 * 60_000), 30)
})

test('snapshot and restore keep totals, trim requests, reject junk', () => {
  const L = newLedger('s', 5, 1)
  for (let i = 0; i < 300; i++) addRequest(L, { turnId: 't', index: i, agentId: null, model: 'claude-opus-5-5', startedAt: i, endedAt: i, usage: u(1000, 0, 0, 0), tools: [] }, 60, 5)
  const back = restore(JSON.parse(JSON.stringify(snapshot(L))))!
  expect(back.requests.length).toBe(200)
  close(ledgerUsd(back), ledgerUsd(L))
  expect(restore({ v: 99 })).toBe(null)
  expect(restore('junk')).toBe(null)
})

test('cost split by kind for main and agents, agents tied to their turn', () => {
  const L = newLedger('s', 0, 0)
  addRequest(L, { turnId: 'A', index: 0, agentId: null, model: 'claude-opus-5-5', startedAt: 10, endedAt: 11, usage: u(0, 0, 100_000, 0), tools: [] }, 60, 5)   // cold: 0.80 $
  addRequest(L, { turnId: 'B', index: 0, agentId: null, model: 'claude-opus-5-5', startedAt: 20, endedAt: 21, usage: u(0, 100_000, 1_000, 1_000), tools: ['Agent'] }, 60, 5)
  noteAgentStart(L, 'g1', { type: 'Explore', model: 'claude-haiku-5-5', at: 22 })
  noteAgentStart(L, 'g2', { type: 'Explore', model: 'claude-haiku-5-5', at: 22 })
  addRequest(L, { turnId: 'g', index: 0, agentId: 'g1', model: 'claude-haiku-5-5', startedAt: 23, endedAt: 24, usage: u(0, 0, 20_000, 100), tools: [] }, 60, 5)
  close(L.parts.main.write, 0.8 + 0.008)
  close(L.parts.main.read, 0.02)
  close(L.parts.main.output, 0.02)
  close(sumParts(L.parts.main), L.main.usd)
  close(sumParts(L.parts.agents), L.agents.g1!.usd)
  expect(L.agents.g1!.turn).toBe('B')
  expect(L.turns.B!.agents).toBe(2)
  expect(L.turns.A!.rewrites).toBe(1)
})

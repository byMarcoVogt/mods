import { expect, test } from 'claude-code/testing'

import { asRecord } from '../hooks/agents'
import { api, pane, setup } from './harness'

// v2 slice 3 (plan/v2-slice3-agents.md): every started session writes its own record; the top session
// reads them all and draws the layers below it on the Agents page, actual against Managed's plan. The
// profile row and the page's one button write the bundle.
const SLOW = { timeoutMs: 60_000 }
const OPUS = 'claude-opus-5-5'
const GET = 'mcp__ccd_session_mgmt__get_session'
const START_SESSION = 'mcp__ccd_session__start_session'
const REC = (parent: string, usd: number, onSonnet: number, title: string, sides: unknown[] = []) =>
  ({ v: 1, parent, title, model: OPUS, usd, onSonnet, agents: { [OPUS]: { n: 2, usd: 1, plan: 0.4 } }, sides, at: 1 })

async function world($: any, on: any, me: { local: string; parent: string; title?: string }, store: Record<string, unknown> = {}, project?: unknown) {
  on('tool.call', { tool: GET } as never, async () => ({ result: '', text: JSON.stringify({ sessionId: me.local, parentSessionId: me.parent, detached: false, title: me.title ?? '' }) }) as never)
  on('tool.call', { tool: START_SESSION } as never, async () => ({ result: 'Started session "x" (session_id: local_a1, name: x)' }) as never)
  const t = setup($, on)
  Object.assign(t.store, { settings: { billing: 'subscription', atTarget: 'off', away: 'keep', coldAsk: 'off' } }, store)
  const files = new Map<string, string>()
  if (project !== undefined) files.set('/w/.token-report/settings.json', JSON.stringify(project))
  const slash = (p: string) => p.split(String.fromCharCode(92)).join('/').replace(/^[A-Z]:/, '')
  on('session.cwd', async () => ({ value: '/w' }))
  on('fs.read', async (_$: unknown, e: { path: string }) => {
    const text = files.get(slash(e.path))
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.write', async (_$: unknown, e: { path: string; text: string }) => { files.set(slash(e.path), e.text); return { value: undefined } })
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  await t.step({ turnId: 't1', index: 0 }, api(0, 60_000, OPUS))
  const turn = () => t.complete({ usage: api(0, 60_000, OPUS) })
  const page = async (columns = 120) => {
    const ui = await $.ui.mount({ plugin: 'token-report', surface: 'desktop', ...pane(columns) } as never)
    await ui.press({ key: 'tab-agents' })
    return ui
  }
  return { t, files, turn, page }
}

test('a started session writes its own flat record each turn; a top session writes none', SLOW, async ($, on) => {
  const { t, turn } = await world($, on, { local: 'local_child', parent: 'local_top', title: 'Dossier X' })
  await turn()
  const rec = asRecord(t.store['side:local_child'])
  expect(rec?.parent).toBe('local_top')
  expect(rec?.title).toBe('Dossier X')
  expect(rec!.usd).toBeGreaterThan(0)
  expect(rec!.onSonnet).toBeGreaterThan(0)
})

test('a top session writes no record of its own', SLOW, async ($, on) => {
  const { t, turn } = await world($, on, { local: 'local_top', parent: '' })
  await turn()
  expect(Object.keys(t.store).filter(k => k.startsWith('side:'))).toEqual([])
})

test('the Agents page draws the layers below this session, rolled up against the plan, with the one button', SLOW, async ($, on) => {
  const store = {
    'side:local_a1': REC('local_top', 4, 1.6, 'Jobby search', [{ child: 'local_b2', about: null, carry: null }]),
    'side:local_b2': REC('local_a1', 1.1, 0.5, 'Dossier X'),
  }
  const { t, files, turn, page } = await world($, on, { local: 'local_top', parent: '' }, store)
  await $.tool.call({ tool: START_SESSION, tool_use_id: 's1', initiation: 'user_asked', title: 'Jobby search', context: 'fresh', prompt: 'brief' } as never)
  await turn()
  const ui = await page()
  const text = await t.drawn(ui)
  expect(text).toContain('Jobby search')
  expect(text).toContain('Dossier X')
  expect(text).toContain('no model named')
  expect(text).toContain('Plan: Managed\'s rule')
  expect(text).toMatch(/2 sessions in 2 layers/)
  expect(text).not.toMatch(/saving|saved/i)
  expect(text).toContain('[Use Managed in w]')
  // The button writes Managed into the project file, whatever the scope picker says
  await ui.press({ key: 'ag-managed' })
  expect(JSON.parse(files.get('/w/.token-report/settings.json')!)).toEqual({ profile: 'managed' })
  expect(await t.drawn(ui)).not.toContain('[Use Managed in w]')
})

test('a started session that never reported shows without money; narrow and empty pages draw', SLOW, async ($, on) => {
  const { t, turn, page } = await world($, on, { local: 'local_top', parent: '' })
  const ui = await page(80)
  let text = await t.drawn(ui)
  expect(text).toContain('No agents or side sessions below this session yet.')
  await $.tool.call({ tool: START_SESSION, tool_use_id: 's1', initiation: 'user_asked', title: 'Never reported', context: 'fresh', model: 'claude-sonnet-5-5', prompt: 'b' } as never)
  await turn()
  text = await t.drawn(ui)
  expect(text).toContain('Never reported')
  expect(text).toContain('not reported')
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn.length).toBeLessThan(100000)
})

test('Settings: Profile Managed writes the scope and clears its bundle keys; a hand key reads as changed', SLOW, async ($, on) => {
  const { t } = await world($, on, { local: 'local_top', parent: '' }, {})
  t.store['settings'] = { ...(t.store['settings'] as object), agentStarts: 'act' }
  const ui: any = await $.ui.mount({ plugin: 'token-report', surface: 'desktop', ...pane(120) } as never)
  await ui.select({ key: 'set-sel-profile', value: 'auto' })
  // Picking a profile in Global removed Global's own hand key
  expect((t.store['settings'] as Record<string, unknown>).agentStarts).toBeUndefined()
  await ui.select({ key: 'set-sel-profile', value: 'managed' })
  expect((t.store['settings'] as Record<string, unknown>).profile).toBe('managed')
  await ui.select({ key: 'set-sel-scope', value: 'session' })
  await ui.select({ key: 'set-sel-agentStarts', value: 'count' })
  expect(await t.drawn(ui)).toContain('1 changed: Agent starts (session)')
})

test('an update with no profile stored keeps every stored hand key, and acts on nothing new', SLOW, async ($, on) => {
  const { t } = await world($, on, { local: 'local_top', parent: '' }, {})
  const ui: any = await $.ui.mount({ plugin: 'token-report', surface: 'desktop', ...pane(120) } as never)
  const values = (await ui.findAll({ type: 'Select' })).map((n: any) => n.props.value)
  // scope, profile, …, unattended, …, agentStarts, sessionStarts: all count
  expect(values[1]).toBe('auto')
  expect(values.filter((v: string) => v === 'act')).toEqual([])
  expect(await t.drawn(ui)).not.toContain('changed')
})

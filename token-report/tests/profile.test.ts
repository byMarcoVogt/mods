import { expect, test } from 'claude-code/testing'

import { mergeLayers, profileView, withProfile, PROFILES } from '../hooks/profile'

// v2 slice 3 (plan/v2-slice3-agents.md § 4): Auto and Managed as a bundle over unattended, agentStarts,
// sessionStarts. A key set by hand in a scope beats that scope's profile; a profile beats what is below it.
const DEFAULTS = { profile: 'auto', unattended: 'count', agentStarts: 'count', sessionStarts: 'count', atTarget: 'remind' } as const
const view = (g: object, p: object, s: object) => {
  const eff = mergeLayers([DEFAULTS, g, p, s]) as any
  return { eff, pv: profileView([{ scope: 'default', values: {} }, { scope: 'global', values: g }, { scope: 'project', values: p }, { scope: 'session', values: s }], eff) }
}

test('profile: the default expands to today\'s values, nothing else changes', () => {
  const { eff, pv } = view({}, {}, {})
  expect([eff.unattended, eff.agentStarts, eff.sessionStarts]).toEqual(['count', 'count', 'count'])
  expect(eff.atTarget).toBe('remind')
  expect(pv).toEqual({ profile: 'auto', from: 'default', changed: [] })
})

test('profile: Global Managed acts everywhere; a Project Auto turns it back for that project', () => {
  expect(view({ profile: 'managed' }, {}, {}).eff.agentStarts).toBe('act')
  const { eff, pv } = view({ profile: 'managed' }, { profile: 'auto' }, {})
  expect(eff.sessionStarts).toBe('count')
  expect(pv.from).toBe('project')
})

test('profile: a hand key in a higher scope wins and shows as changed', () => {
  const { eff, pv } = view({}, { profile: 'managed' }, { agentStarts: 'count' })
  expect(eff.agentStarts).toBe('count')
  expect(eff.unattended).toBe('act')
  expect(pv.profile).toBe('managed')
  expect(pv.changed).toEqual([{ key: 'agentStarts', label: 'Agent starts', from: 'session' }])
})

test('profile: a stored hand key from before the update keeps acting, read as "Auto, 1 changed"', () => {
  const { eff, pv } = view({ unattended: 'act' }, {}, {})
  expect(eff.unattended).toBe('act')
  expect(pv.profile).toBe('auto')
  expect(pv.changed.map(c => c.key + ':' + c.from)).toEqual(['unattended:global'])
})

test('profile: a project profile beats a Global hand key below it', () => {
  expect(view({ unattended: 'act' }, { profile: 'auto' }, {}).eff.unattended).toBe('count')
})

test('profile: a hand key in the same scope beats that scope\'s profile', () => {
  const { eff, pv } = view({}, { profile: 'managed', sessionStarts: 'count' }, {})
  expect(eff.sessionStarts).toBe('count')
  expect(pv.changed.map(c => c.from)).toEqual(['project'])
})

test('profile: picking one clears that scope\'s own bundle keys, nothing else', () => {
  expect(withProfile({ agentStarts: 'count', unattended: 'act', away: 'keep' } as any, 'managed')).toEqual({ away: 'keep', profile: 'managed' })
  expect(PROFILES.managed).toEqual({ unattended: 'act', agentStarts: 'act', sessionStarts: 'act' })
})

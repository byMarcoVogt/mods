// token-report profiles (v2 slice 3, plan/v2-slice3-agents.md § 4): Auto and Managed as a bundle over the
// three keys that decide whether the mod steps into work nobody watches. Pure, like ledger.ts.
//
// Each scope layer (Defaults < Global < Project < Session) is expanded before the merge: a key set by
// hand in a scope beats that scope's profile, and a profile in a scope beats everything below it.
import type { Settings } from '../types'

export type Profile = Settings['profile']
export const BUNDLE_KEYS = ['unattended', 'agentStarts', 'sessionStarts'] as const
export type BundleKey = (typeof BUNDLE_KEYS)[number]
export const PROFILES: Record<Profile, Pick<Settings, BundleKey>> = {
  auto: { unattended: 'count', agentStarts: 'count', sessionStarts: 'count' },
  managed: { unattended: 'act', agentStarts: 'act', sessionStarts: 'act' },
}
// The Settings rows' own labels
export const BUNDLE_LABELS: Record<BundleKey, string> = { unattended: 'Turns nobody typed', agentStarts: 'Agent starts', sessionStarts: 'Session starts' }

export type Scope = 'default' | 'global' | 'project' | 'session'
export type Layer = { scope: Scope; values: Partial<Settings> }

// One layer with its profile expanded: its own keys beat its own profile
export function expand(values: Partial<Settings>): Partial<Settings> {
  const p = values.profile
  return p && PROFILES[p] ? { ...PROFILES[p], ...values } : { ...values }
}
export const mergeLayers = (layers: Partial<Settings>[]): Partial<Settings> => Object.assign({}, ...layers.map(expand))

// A scope's values after a profile is picked there: the profile, and that scope's own bundle keys gone,
// so the row reads clean afterwards
export function withProfile(values: Partial<Settings>, profile: Profile): Partial<Settings> {
  const next: Record<string, unknown> = { ...values, profile }
  for (const key of BUNDLE_KEYS) delete next[key]
  return next as Partial<Settings>
}

export type ProfileView = {
  profile: Profile
  // The highest scope that set the profile ('default' when none did)
  from: Scope
  // Bundle keys whose value in force differs from the profile's, with the scope that set them
  changed: { key: BundleKey; label: string; from: Scope }[]
}
export function profileView(layers: Layer[], effective: Pick<Settings, 'profile' | BundleKey>): ProfileView {
  const profile: Profile = PROFILES[effective.profile] ? effective.profile : 'auto'
  let from: Scope = 'default'
  for (const l of layers) if (l.values.profile) from = l.scope
  const changed: ProfileView['changed'] = []
  for (const key of BUNDLE_KEYS) {
    if (effective[key] === PROFILES[profile][key]) continue
    let by: Scope = 'default'
    for (const l of layers) if (expand(l.values)[key] !== undefined) by = l.scope
    changed.push({ key, label: BUNDLE_LABELS[key], from: by })
  }
  return { profile, from, changed }
}

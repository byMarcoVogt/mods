import { expect, test } from 'claude-code/testing'

import {
  amountMatters, answerOf, classifyStart, forkGuardFires, handBackAgent, handBackFork, handBackModel, isExpensive,
  jobKey, modelName, noteExplicit, ratioTo, startResult, toolKind,
} from '../hooks/router'

// v2 slice 2 (plan/v2-slice2-router.md § 3–4): the router's pure rules.

test('agent type decides first: Explore and wrappers gather, Plan and review types do not', async () => {
  expect(classifyStart('Explore', 'fix the bug', '')).toEqual({ cls: 'gather', signal: 'type' })
  expect(classifyStart('gpt', 'Second opinion', '')).toEqual({ cls: 'gather', signal: 'type' })
  expect(classifyStart('myplugin:gpt-review', 'anything', '')).toEqual({ cls: 'gather', signal: 'type' })
  expect(classifyStart('Plan', 'research the options', '')).toEqual({ cls: 'other', signal: 'type' })
  expect(classifyStart('code-reviewer', 'search', '').cls).toBe('other')
  expect(classifyStart('fork', 'search', '').cls).toBe('other')
})

test('build or review words beat gathering words; negated edits do not count as building', async () => {
  expect(classifyStart('general-purpose', 'Research and fix the bug', '').cls).toBe('other')
  expect(classifyStart('general-purpose', 'Review the PR', 'search for problems').cls).toBe('other')
  expect(classifyStart('general-purpose', 'Web research: ski resorts', '')).toEqual({ cls: 'gather', signal: 'words' })
  expect(classifyStart('general-purpose', 'Collect sources', 'Do not edit any file. Report back.').cls).toBe('gather')
  expect(classifyStart('general-purpose', 'Quellen sammeln', '').cls).toBe('gather')
  expect(classifyStart('general-purpose', 'Recherche Mietpreise', '').cls).toBe('gather')
  expect(classifyStart('general-purpose', 'Entwurf prüfen', 'suche Fehler').cls).toBe('other')
  expect(classifyStart('general-purpose', 'Ask GPT for a draft', '').cls).toBe('gather')
  // Words inside other words do not count
  expect(classifyStart('general-purpose', 'Prefix credit lookup', '').cls).toBe('gather')
  // A builder named after its subject; "explor" is not a gathering word
  expect(classifyStart('general-purpose', 'Variante besitz-explorer', '').cls).toBe('other')
  expect(classifyStart('general-purpose', 'Implement the band', 'search the code first').cls).toBe('other')
})

test('a job is the prompt with model names, case and spacing evened out', async () => {
  const a = jobKey('Review   this with Opus')
  expect(a).toBe(jobKey('review this with sonnet'))
  expect(a).toBe(jobKey('Review this with claude-fable-5-1'))
  expect(a).not.toBe(jobKey('Review that with opus'))
  expect(a).toMatch(/^[0-9a-f]{8}$/)
})

test('expensive means Opus or Fable by list price; ratios come from the price table', async () => {
  expect(isExpensive('claude-opus-5-5')).toBe(true)
  expect(isExpensive('claude-fable-5-1')).toBe(true)
  expect(isExpensive('opus')).toBe(true)
  expect(isExpensive('claude-sonnet-5-5')).toBe(false)
  expect(isExpensive('claude-haiku-5-5')).toBe(false)
  expect(isExpensive('')).toBe(false)
  // An unknown id falls back to Opus 5.5 as priceFor does
  expect(isExpensive('gateway-model-x')).toBe(true)
  expect(ratioTo('claude-opus-5-5')).toBe(0.5)
  expect(ratioTo('claude-fable-5-1')).toBe(0.2)
})

test('the amount matters on a warm expensive parent, not on a cold giant', async () => {
  expect(amountMatters(400_000, 'claude-opus-5-5', false, 60)).toBe(true)
  expect(amountMatters(1_000_000, 'claude-fable-5-1', true, 60)).toBe(false)
})

test('fork guard: carry above a fresh start, or a cold parent above 85k', async () => {
  expect(forkGuardFires(100_000, 'claude-opus-5-5', false)).toBe(false)
  expect(forkGuardFires(150_000, 'claude-opus-5-5', false)).toBe(true)
  expect(forkGuardFires(90_000, 'claude-opus-5-5', true)).toBe(true)
  expect(forkGuardFires(60_000, 'claude-opus-5-5', true)).toBe(false)
})

test('the caller\'s answer: cheaper, the same, another; tools sort into kinds; start results parse', async () => {
  expect(answerOf('sonnet', 'claude-opus-5-5')).toBe('cheaper')
  expect(answerOf('opus', 'claude-opus-5-5')).toBe('same_model')
  expect(answerOf('', 'claude-opus-5-5')).toBe('same_model')
  expect(answerOf('fable', 'claude-opus-5-5')).toBe('other_model')
  expect(toolKind('WebFetch')).toBe('web')
  expect(toolKind('mcp__pw-bg__browser_navigate')).toBe('browser')
  expect(toolKind('mcp__claude-in-chrome__computer')).toBe('browser')
  expect(toolKind('Grep')).toBe('read')
  expect(toolKind('Edit')).toBe('write')
  expect(toolKind('Bash')).toBe('other')
  expect(startResult({ text: 'Started session "x" (session_id: local_ab-12, name: x)' })).toEqual({ result: 'started', child: 'local_ab-12' })
  expect(startResult({ result: 'Proposed "x" (task_id: task_9f3a)' })).toEqual({ result: 'proposed', child: 'task_9f3a' })
  expect(startResult({ isError: true, text: 'no' })).toEqual({ result: 'refused', child: null })
})

test('wordings: filled, short, no prompt text', async () => {
  const all = [
    handBackAgent('words', 'claude-opus-5-5'), handBackAgent('type', 'claude-fable-5-1'), noteExplicit('opus'),
    handBackFork(180_000, 'claude-opus-5-5', false), handBackFork(180_000, 'claude-opus-5-5', true), handBackModel('claude-opus-5-5'),
  ]
  for (const text of all) {
    expect(text.length).toBeLessThanOrEqual(600)
    expect(text).not.toMatch(/undefined|NaN|null/)
  }
  expect(all[0]).toContain('Opus 5.5')
  expect(all[0]).toContain('0.5×')
  expect(all[0]).toContain('model: "sonnet"')
  expect(all[1]).toContain('0.2×')
  expect(all[3]).toContain('180k tokens')
  expect(all[4]).toContain('Use start_session with context: "fresh"')
  expect(modelName('claude-fable-5-1')).toBe('Fable 5.1')
})

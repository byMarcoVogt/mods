import { expect, test } from 'claude-code/testing'

import { C } from '../hooks/kit'
import { FIVE_HOURS_MS, paceColor } from '../hooks/line'

const left = (elapsedMin: number) => FIVE_HOURS_MS - elapsedMin * 60_000

test('5h pace: what this pace reaches by the reset decides the colour', () => {
  expect(paceColor(10, left(60))).toBe(C.ok)      // 10 % after 1 h → 50 % by the reset
  expect(paceColor(20, left(60))).toBe(C.warn)    // 20 % after 1 h → 100 %
  expect(paceColor(30, left(60))).toBe(C.red)     // 30 % after 1 h → 150 %
  expect(paceColor(17, left(60))).toBe(C.ok)      // → 85 %
})

test('5h pace: colourless in the first 30 min, red at 90 % used whatever the pace', () => {
  expect(paceColor(3, left(5))).toBeNull()        // three times the pace, but only 5 min in
  expect(paceColor(91, left(290))).toBe(C.red)    // nearly at the reset, but 91 % used
  expect(paceColor(40, null)).toBeNull()          // no reset time known
})

import { expect, test } from 'claude-code/testing'

import {
  MIN,
  fmtDur,
  fmtUsd,
  makePlan,
  parseHours,
  pingsIn,
  priceOf,
  thresholdTokens,
} from '../hooks/model.ts'

test('prices match the official table by model id', () => {
  expect(priceOf('claude-sonnet-5-5').id).toBe('sonnet-5-5')
  expect(priceOf('claude-opus-4-8[1m]').id).toBe('opus-4-8')
  const fable = priceOf('claude-fable-5-1')
  expect([fable.write, fable.read]).toEqual([20, 0.25])
  const opus55 = priceOf('claude-opus-5-5')
  expect([opus55.write, opus55.read]).toEqual([8, 0.2])
  expect(priceOf('claude-opus-5').id).toBe('opus-5')
  expect(priceOf('something-else').isGuess).toBe(true)
  expect(priceOf('claude-opus-9-9').isGuess).toBe(true)
})

test('reminder threshold is the context where going cold costs $0.30, floored at 30k', () => {
  expect(thresholdTokens(priceOf('claude-sonnet-5-5'))).toBe(78948)
  expect(thresholdTokens(priceOf('claude-opus-5-5'))).toBe(38462)
  expect(thresholdTokens(priceOf('claude-opus-5'))).toBe(31579)
  expect(thresholdTokens(priceOf('claude-haiku-4-5'))).toBe(157895)
  // Fable 5.1 works out to about 15k, which the floor lifts to 30k
  expect(thresholdTokens(priceOf('claude-fable-5-1'))).toBe(30000)
})

test('hours input: blank is the default, and only 0..24 is accepted', () => {
  expect(parseHours('')).toBe(4)
  expect(parseHours('3')).toBe(3)
  expect(parseHours('1.5h')).toBe(1.5)
  expect(parseHours('0')).toBeNull()
  expect(parseHours('25')).toBeNull()
  expect(parseHours('abc')).toBeNull()
})

test('ping count follows the 50-minute chain from the last cache touch', () => {
  const now = 10_000_000
  expect(pingsIn(4, now, now)).toBe(4)
  // 41 minutes idle already: 4h more is 281 minutes from the touch
  expect(pingsIn(4, now - 41 * MIN, now)).toBe(5)
  expect(pingsIn(0.5, now, now)).toBe(0)
})

test('312k context on Sonnet 5.5, subscription basis: numbers match the worked example', () => {
  const now = 10_000_000
  const plan = makePlan({ ctx: 312_000, price: priceOf('claude-sonnet-5-5'), basis: 'subscription', hours: 4, lastReq: now, now, isWarm: true })
  expect(plan.pings).toBe(4)
  expect(Math.round(plan.warmUnits)).toBe(34944)
  expect(Math.round(plan.compactUnits)).toBe(72176)
  expect(Math.round(plan.nothingUnits)).toBe(365664)
  expect(plan.breakEvenHours).toBeGreaterThan(6.8)
  expect(plan.breakEvenHours).toBeLessThan(7)
  expect(plan.recommended).toBe('warm')
  expect(fmtUsd(plan.warmUsd)).toBe('$0.25')
  expect(fmtUsd(plan.compactUsd)).toBe('$0.22')
  expect(fmtUsd(plan.nothingUsd)).toBe('$1.19')
})

test('a long absence flips the recommendation to compact', () => {
  const now = 10_000_000
  const plan = makePlan({ ctx: 312_000, price: priceOf('claude-sonnet-5-5'), basis: 'subscription', hours: 12, lastReq: now, now, isWarm: true })
  expect(plan.pings).toBe(14)
  expect(plan.recommended).toBe('compact')
})

test('a small context or a cold cache recommends doing nothing', () => {
  const now = 10_000_000
  const small = makePlan({ ctx: 20_000, price: priceOf('claude-sonnet-5-5'), basis: 'subscription', hours: 4, lastReq: now, now, isWarm: true })
  expect(small.recommended).toBe('nothing')
  const cold = makePlan({ ctx: 312_000, price: priceOf('claude-sonnet-5-5'), basis: 'subscription', hours: 4, lastReq: now - 70 * MIN, now, isWarm: false })
  expect(cold.recommended).toBe('nothing')
  expect(cold.pings).toBe(0)
  expect(cold.paybackTurns).toBeGreaterThan(5)
})

test('durations read as 10m and 3h20m', () => {
  expect(fmtDur(10 * MIN)).toBe('10m')
  expect(fmtDur(200 * MIN)).toBe('3h20m')
  expect(fmtDur(-5)).toBe('0m')
})

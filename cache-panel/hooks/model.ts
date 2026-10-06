// Pure cost model for the cache panel: no engine calls in here.
//
// Two bases are computed side by side:
//   - API list prices (official pricing page, checked 2026-10-04)
//   - subscription weights, measured by a Reddit user as multiples of one plain
//     input token: cache read 0.028, 1h cache write 1.2, output 5. Approximate,
//     measured on Fable 5.1 and Opus 5 only; applied to every model here.

export const MIN = 60_000
export const HOUR = 60 * MIN
/** The 1-hour prompt cache. */
export const TTL_MS = HOUR
/** A ping lands this long after the last request that touched the cache. */
export const PING_EVERY_MS = 50 * MIN
export const DEFAULT_HOURS = 4
export const MAX_HOURS = 24
/** Remind only when letting the cache go cold would cost at least this much (API-equivalent USD). */
export const STAKE_USD = 0.3
/** Never remind below this many context tokens, whatever the price. */
export const FLOOR_TOKENS = 30_000
/** Assumed size of the summary a compaction writes. */
export const SUMMARY_TOKENS = 8_000
/** Assumed size of the conversation right after a compaction. */
export const COMPACTED_TOKENS = 20_000

export type Basis = 'subscription' | 'api'

export type Price = {
  id: string
  /** $ per million tokens */
  inp: number
  write: number
  read: number
  out: number
  /** True when the model id was not found and a family default was used. */
  isGuess: boolean
}

// key, base input, 1h cache write, cache read, output ($ per million tokens).
// Longer keys first: an id matches the first key it starts with.
const TABLE: ReadonlyArray<readonly [string, number, number, number, number]> = [
  ['fable-5-1', 10, 20, 0.25, 50],
  ['mythos-5-1', 10, 20, 0.25, 50],
  ['fable-5', 10, 20, 1, 50],
  ['mythos-5', 10, 20, 1, 50],
  ['opus-5-5', 4, 8, 0.2, 20],
  ['opus-5', 5, 10, 0.5, 25],
  ['opus-4-8', 5, 10, 0.5, 25],
  ['opus-4-7', 5, 10, 0.5, 25],
  ['opus-4-6', 5, 10, 0.5, 25],
  ['opus-4-5', 5, 10, 0.5, 25],
  ['opus-4-1', 15, 30, 1.5, 75],
  ['opus-4', 15, 30, 1.5, 75],
  ['sonnet-5-5', 2, 4, 0.2, 10],
  ['sonnet-5', 2, 4, 0.2, 10],
  ['sonnet-4-6', 3, 6, 0.3, 15],
  ['sonnet-4-5', 3, 6, 0.3, 15],
  ['sonnet-4', 3, 6, 0.3, 15],
  ['haiku-4-5', 1, 2, 0.1, 5],
  ['haiku-3-5', 0.8, 1.6, 0.08, 4],
]

const FAMILY: ReadonlyArray<readonly [string, string]> = [
  ['fable', 'fable-5-1'],
  ['mythos', 'mythos-5-1'],
  ['opus', 'opus-5-5'],
  ['sonnet', 'sonnet-5-5'],
  ['haiku', 'haiku-4-5'],
]

export function normalizeModel(model: string): string {
  return String(model || '')
    .toLowerCase()
    .replace(/^claude-/, '')
    .replace(/\[.*?\]/g, '')
    .replace(/-\d{8}$/, '')
    .trim()
}

function rowOf(key: string, isGuess: boolean): Price | null {
  for (const [k, inp, write, read, out] of TABLE) {
    if (k === key) return { id: k, inp, write, read, out, isGuess }
  }
  return null
}

export function priceOf(model: string): Price {
  const id = normalizeModel(model)
  for (const [k] of TABLE) {
    if (id.startsWith(k)) return rowOf(k, false) as Price
  }
  for (const [family, key] of FAMILY) {
    if (id.includes(family)) return rowOf(key, true) as Price
  }
  return rowOf('sonnet-5-5', true) as Price
}

export type Ratios = { r: number; w: number; o: number }

/** Subscription weights, as multiples of one plain input token. */
export const SUBSCRIPTION: Ratios = { r: 0.028, w: 1.2, o: 5 }

export function apiRatios(p: Price): Ratios {
  return { r: p.read / p.inp, w: p.write / p.inp, o: p.out / p.inp }
}

export function ratiosFor(basis: Basis, p: Price): Ratios {
  return basis === 'subscription' ? SUBSCRIPTION : apiRatios(p)
}

/** Context tokens above which letting the cache go cold costs at least STAKE_USD. */
export function thresholdTokens(p: Price): number {
  const perToken = (p.write - p.read) / 1e6
  return Math.max(FLOOR_TOKENS, Math.ceil(STAKE_USD / perToken))
}

/** One keep-warm ping over a context of `c` tokens, in plain-input-token units. */
export function pingUnits(c: number, x: Ratios): number {
  return c * x.r
}

/** Extra cost of letting the next turn rewrite the whole context instead of reading it. */
export function nothingUnits(c: number, x: Ratios): number {
  return c * (x.w - x.r)
}

/**
 * A compaction: one request over the whole context (a read while the cache is
 * warm, a write once it is cold), the summary, and the next turn writing the
 * short new context instead of reading it.
 */
export function compactUnits(c: number, x: Ratios, isWarm: boolean): number {
  return c * (isWarm ? x.r : x.w) + SUMMARY_TOKENS * x.o + COMPACTED_TOKENS * (x.w - x.r)
}

export function toUsd(units: number, p: Price): number {
  return (units * p.inp) / 1e6
}

/** Pings a keep-warm window of `hours` from `now` will send, given the last cache touch. */
export function pingsIn(hours: number, lastReq: number, now: number): number {
  const end = now + hours * HOUR
  const from = lastReq > 0 ? lastReq : now
  return Math.max(0, Math.floor((end - from) / PING_EVERY_MS))
}

/** "" means the default; accepts 3, 3h, 1.5. Null when not a number in (0, MAX_HOURS]. */
export function parseHours(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/h$/, '').trim()
  if (t === '') return DEFAULT_HOURS
  if (!/^\d+(\.\d+)?$/.test(t)) return null
  const n = Number(t)
  return n > 0 && n <= MAX_HOURS ? n : null
}

export type Pick = 'warm' | 'compact' | 'nothing'

export type Plan = {
  hours: number
  pings: number
  warmUnits: number
  warmUsd: number
  compactUnits: number
  compactUsd: number
  nothingUnits: number
  nothingUsd: number
  /** Hours of absence up to which keep-warm costs less than compacting. */
  breakEvenHours: number
  recommended: Pick
  /** Turns after which compacting a cold context has paid for itself through smaller reads. */
  paybackTurns: number
}

export type PlanInput = {
  ctx: number
  price: Price
  basis: Basis
  hours: number
  lastReq: number
  now: number
  isWarm: boolean
}

export function makePlan(i: PlanInput): Plan {
  const x = ratiosFor(i.basis, i.price)
  const api = apiRatios(i.price)
  const pings = i.isWarm ? pingsIn(i.hours, i.lastReq, i.now) : 0
  const warmU = pings * pingUnits(i.ctx, x)
  const compactU = compactUnits(i.ctx, x, i.isWarm)
  const nothingU = nothingUnits(i.ctx, x)
  const pingU = pingUnits(i.ctx, x)
  const breakEvenHours = pingU > 0 ? ((compactUnits(i.ctx, x, true) / pingU) * PING_EVERY_MS) / HOUR : 0

  let recommended: Pick
  if (!i.isWarm || i.ctx < FLOOR_TOKENS) {
    recommended = 'nothing'
  } else {
    const best: Pick = warmU <= compactU ? 'warm' : 'compact'
    const bestU = Math.min(warmU, compactU)
    recommended = nothingU <= bestU ? 'nothing' : best
  }

  const saving = (i.ctx - COMPACTED_TOKENS) * x.r
  const extra = compactU - nothingU
  const paybackTurns = extra <= 0 ? 0 : saving > 0 ? extra / saving : Infinity

  return {
    hours: i.hours,
    pings,
    warmUnits: warmU,
    warmUsd: toUsd(pings * pingUnits(i.ctx, api), i.price),
    compactUnits: compactU,
    compactUsd: toUsd(compactUnits(i.ctx, api, i.isWarm), i.price),
    nothingUnits: nothingU,
    nothingUsd: toUsd(nothingUnits(i.ctx, api), i.price),
    breakEvenHours,
    recommended,
    paybackTurns,
  }
}

export function fmtK(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1000) return Math.round(n / 1000) + 'k'
  return String(Math.round(n))
}

export function fmtUsd(u: number): string {
  if (u > 0 && u < 0.01) return '<$0.01'
  return '$' + u.toFixed(2)
}

export function fmtDur(ms: number): string {
  const total = Math.max(0, Math.round(ms / MIN))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

export function fmtHours(h: number): string {
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`
}

const pad = (s: string, n: number): string => s.padEnd(n)

/**
 * The three options as one line each. Narrow (a side-by-side herdr pane, about 21
 * usable columns): short labels, so nothing wraps and the whole panel stays short
 * enough for the arrow keys to move focus instead of scrolling it.
 */
export function optionRows(p: Plan, isWarm: boolean, narrow: boolean): string[] {
  const warmLabel = narrow ? (isWarm ? `Warm ${fmtHours(p.hours)}` : 'Warm') : isWarm ? `Keep warm ${fmtHours(p.hours)}` : 'Keep warm'
  const items: Array<readonly [string, string, string]> = [
    [warmLabel, isWarm ? '~' + fmtK(p.warmUnits) : 'n/a', isWarm ? fmtUsd(p.warmUsd) : 'n/a'],
    ['Compact', '~' + fmtK(p.compactUnits), fmtUsd(p.compactUsd)],
    [narrow ? 'Nothing' : 'Do nothing', '~' + fmtK(p.nothingUnits), fmtUsd(p.nothingUsd)],
  ]
  const w1 = narrow ? 9 : 14
  const w2 = narrow ? 6 : 8
  return items.map(([label, units, usd]) => `${pad(label, w1)}${pad(units, w2)}${usd}`)
}

export function pickLabel(pick: Pick): string {
  return pick === 'warm' ? 'Keep warm' : pick === 'compact' ? 'Compact' : 'Do nothing'
}

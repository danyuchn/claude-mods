import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { PingInfo, Snap, Warm } from '../types'
import {
  DEFAULT_HOURS,
  HOUR,
  MAX_HOURS,
  PING_EVERY_MS,
  TTL_MS,
  fmtDur,
  fmtHours,
  fmtK,
  fmtUsd,
  makePlan,
  parseHours,
  pickLabel,
  priceOf,
  optionRows,
  thresholdTokens,
} from './model.ts'

// Passive reminder at minute 50 of idle, one panel to decide keep-warm / ping / compact.
// Everything except the reminder is opened by the person: the band button, or /warm.

const PANE = 'cache-panel'
const REMIND_AFTER_MS = 50 * 60_000
const TICK_MS = 30_000
const TOAST_MS = 5000
const PING_PROMPT = 'Reply with exactly: ok'

// CACHE_PANEL_FAST=1 shortens the clocks so the whole flow can be tried in a few minutes.
let remindAfter = REMIND_AFTER_MS
let pingEvery = PING_EVERY_MS
let isFast = false

const EMPTY_SNAP: Snap = { ctx: 0, model: '', hasLimits: false, fiveHour: null }

const nowAt = atom({ plugin: 'cache-panel', key: 'nowAt' } as const, 0)
const lastRequestAt = atom({ plugin: 'cache-panel', key: 'lastRequestAt' } as const, 0)
const remindedFor = atom({ plugin: 'cache-panel', key: 'remindedFor' } as const, 0)
const isReminding = atom({ plugin: 'cache-panel', key: 'isReminding' } as const, false)
const hoursText = atom({ plugin: 'cache-panel', key: 'hoursText' } as const, '')
const warm = atom({ plugin: 'cache-panel', key: 'warm' } as const, null)
const snap = atom({ plugin: 'cache-panel', key: 'snap' } as const, EMPTY_SNAP)
const note = atom({ plugin: 'cache-panel', key: 'note' } as const, '')

let remindTimer: Timer | undefined
let pingTimer: Timer | undefined

function folderOf(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() ?? cwd
}

async function refreshSnap($: EngineInterface): Promise<void> {
  const u = await $.session.usage()
  const model = await $.session.model()
  const five = u.rateLimits.find(l => l.kind === 'five_hour')
  const next: Snap = {
    ctx: u.context.tokens ?? 0,
    model,
    hasLimits: u.rateLimits.length > 0,
    fiveHour: five ? Math.round(five.percentUsed) : null,
  }
  await update($, snap, () => next)
}

/** Sound and a notice through herdr, the way herdr raises its own agent alerts. */
async function notify($: EngineInterface, title: string, body: string): Promise<void> {
  const inHerdr = await $.env.get('HERDR_ENV')
  if (inHerdr !== '1') return
  const bin = (await $.env.get('HERDR_BIN_PATH')) || 'herdr'
  try {
    const r = await $.process.run([bin, 'notification', 'show', title, '--body', body, '--sound', 'done'], { timeoutMs: 5000 })
    $.ui.log(`notify exit=${r.exitCode} ${r.stdout.trim().slice(0, 120)}`, { to: 'debug' })
  } catch (err) {
    // The reminder line is still on screen; a failed sound is not worth a toast.
    $.ui.log(`notify failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

async function isWarmNow($: EngineInterface, now: number): Promise<boolean> {
  const w = await read($, warm)
  return w !== null && now < w.deadline
}

/** Minute 50 of idle with the cache still alive: show the line and ring once per idle stretch. */
async function remindIfDue($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, nowAt, () => now)
  const last = await read($, lastRequestAt)
  if (last === 0) return
  const idle = now - last
  if (idle < remindAfter - 1000 || idle >= TTL_MS) return
  if (await isWarmNow($, now)) return
  if ((await read($, remindedFor)) === last) return
  await refreshSnap($)
  const s = await read($, snap)
  if (!isFast && s.ctx < thresholdTokens(priceOf(s.model))) return
  await update($, remindedFor, () => last)
  await update($, isReminding, () => true)
  $.ui.log(`reminder due: idle ${fmtDur(idle)}, ctx ${fmtK(s.ctx)}, model ${s.model}`, { to: 'debug' })
  const cwd = await $.session.cwd()
  await notify($, `Cache cools in ${fmtDur(last + TTL_MS - now)}`, `${folderOf(cwd)} · ${fmtK(s.ctx)}`)
}

function armReminder($: EngineInterface): void {
  remindTimer?.cancel()
  remindTimer = $.clock.after(remindAfter, () => void remindIfDue($))
}

/** The next keep-warm ping, one period after the last request that touched the cache. */
async function armPing($: EngineInterface): Promise<void> {
  pingTimer?.cancel()
  pingTimer = undefined
  const w = await read($, warm)
  if (w === null) return
  const now = await $.clock.now()
  if (now >= w.deadline) {
    await endWarm($, 'expired')
    return
  }
  const last = await read($, lastRequestAt)
  // Nothing to keep warm until a request has run, and a cold cache is not worth paying for.
  if (last === 0 || now - last >= TTL_MS) return
  const delay = Math.min(Math.max(1000, last + pingEvery - now), w.deadline - now)
  pingTimer = $.clock.after(delay, () => void runPing($))
}

/** A request, or a ping, touched the cache just now. */
async function touch($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, nowAt, () => now)
  await update($, lastRequestAt, () => now)
  await update($, isReminding, () => false)
  armReminder($)
  await armPing($)
}

async function runPing($: EngineInterface): Promise<void> {
  pingTimer = undefined
  const w = await read($, warm)
  if (w === null) return
  const now = await $.clock.now()
  if (now >= w.deadline) {
    await endWarm($, 'expired')
    return
  }
  const last = await read($, lastRequestAt)
  // A request since the timer was set moved the ping later.
  if (now - last < pingEvery - 1000) {
    await armPing($)
    return
  }
  await doPing($, 'window')
}

async function endWarm($: EngineInterface, why: 'expired' | 'stopped' | 'error', message?: string): Promise<void> {
  pingTimer?.cancel()
  pingTimer = undefined
  await update($, warm, () => null)
  if (why === 'expired') $.ui.toast('Keep-warm ended', { timeoutMs: TOAST_MS })
  else if (why === 'stopped') $.ui.toast('Keep-warm stopped', { timeoutMs: TOAST_MS })
  else $.ui.toast(message ?? 'Keep-warm stopped: ping failed', { timeoutMs: 8000 })
  await remindIfDue($)
}

/** One tool-less fork over the transcript: the server answers it from the cache and the hour restarts. */
async function doPing($: EngineInterface, kind: 'window' | 'once'): Promise<void> {
  const now = await $.clock.now()
  const last = await read($, lastRequestAt)
  if (last > 0 && now - last >= TTL_MS) {
    $.ui.toast('Cache is already cold', { timeoutMs: TOAST_MS })
    return
  }
  let reply: Awaited<ReturnType<EngineInterface['model']['fork']>> | undefined
  let failure = ''
  try {
    reply = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  }
  const usage = reply !== undefined && 'usage' in reply ? reply.usage : undefined
  if (usage === undefined) {
    const why = reply !== undefined && !reply.isAnswered ? reply.reason : failure || 'no reply'
    const text = `Ping failed: ${why}`
    if (kind === 'window') await endWarm($, 'error', text)
    else $.ui.toast(text, { timeoutMs: 8000 })
    return
  }
  const isWarm = usage.cache_read_input_tokens > 0 && usage.cache_creation_input_tokens < 0.1 * usage.cache_read_input_tokens
  const info: PingInfo = {
    at: now,
    read: usage.cache_read_input_tokens,
    write: usage.cache_creation_input_tokens,
    out: usage.output_tokens,
    isWarm,
  }
  $.ui.log(`ping(${kind}): read ${info.read}, write ${info.write}, out ${info.out}, warm=${isWarm}`, { to: 'debug' })
  await update($, note, () =>
    isWarm
      ? `Last ping: read ${fmtK(info.read)}, out ${info.out}`
      : `Last ping: read ${fmtK(info.read)}, wrote ${fmtK(info.write)} (new entry)`,
  )
  if (!isWarm) {
    // The ping wrote the cache: it is warm now. In a young session this is normal (the fork
    // starts its own entry and the next ping reads it), so one miss in a row is tolerated.
    if (kind === 'window') {
      const w0 = await read($, warm)
      if (w0 !== null && w0.misses === 0) {
        await update($, warm, (w: Warm | null) => (w === null ? null : { ...w, misses: 1, last: info }))
      } else {
        await endWarm($, 'error', `Keep-warm stopped: pings keep missing (read ${fmtK(info.read)}, wrote ${fmtK(info.write)})`)
      }
    } else {
      $.ui.toast(`Pinged: wrote ${fmtK(info.write)}, cache held another hour`, { timeoutMs: TOAST_MS })
    }
    await touch($)
    return
  }
  if (kind === 'window') {
    await update($, warm, (w: Warm | null) => (w === null ? null : { ...w, pings: w.pings + 1, misses: 0, last: info }))
  } else {
    $.ui.toast(`Pinged: cache read ${fmtK(info.read)}, held another hour`, { timeoutMs: TOAST_MS })
  }
  await touch($)
}

async function startWarm($: EngineInterface, hours: number): Promise<void> {
  const now = await $.clock.now()
  const last = await read($, lastRequestAt)
  if (last > 0 && now - last >= TTL_MS) {
    $.ui.toast('Cache is already cold', { timeoutMs: TOAST_MS })
    return
  }
  await update($, warm, () => ({ startedAt: now, deadline: now + hours * HOUR, pings: 0, misses: 0, last: null }))
  await update($, isReminding, () => false)
  await armPing($)
  $.ui.toast(`Keep warm on for ${fmtHours(hours)}`, { timeoutMs: 3000 })
  await $.ui.close({ id: PANE })
}

async function openPanel($: EngineInterface): Promise<void> {
  await refreshSnap($)
  const now = await $.clock.now()
  await update($, nowAt, () => now)
  await update($, hoursText, () => '')
  await $.ui.open({ id: PANE, title: 'Cache', focus: true, closeOnEscape: true, rows: 12 })
}

async function compactNow($: EngineInterface): Promise<void> {
  await $.ui.close({ id: PANE })
  try {
    await $.command.run({ command: 'compact', args: '' })
  } catch (err) {
    $.ui.toast(`Compact failed: ${err instanceof Error ? err.message : String(err)}`, { timeoutMs: 8000 })
  }
}

async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, nowAt, () => now)
  const w = await read($, warm)
  if (w !== null && now >= w.deadline) await endWarm($, 'expired')
  const last = await read($, lastRequestAt)
  if ((await read($, isReminding)) && last > 0 && now - last >= TTL_MS) await update($, isReminding, () => false)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, nowAt, () => now)
    await refreshSnap($)
    if ((await $.env.get('CACHE_PANEL_FAST')) === '1') {
      isFast = true
      remindAfter = 60_000
      pingEvery = 120_000
    }
    $.clock.every(TICK_MS, () => void tick($))
    try {
      await $.command.register({
        name: 'warm',
        description: 'Cache panel: keep warm, ping once, or compact',
        argumentHint: '[hours | off]',
        immediate: true,
      })
    } catch {
      try {
        await $.command.register({
          name: 'cache-panel',
          description: 'Cache panel: keep warm, ping once, or compact',
          argumentHint: '[hours | off]',
          immediate: true,
        })
      } catch {
        // Both names are taken; the band button still opens the panel.
      }
    }
    return next(e)
  })

  // /clear, /resume and /branch reset the session's state: stop the timers that belonged to it.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    remindTimer?.cancel()
    remindTimer = undefined
    pingTimer?.cancel()
    pingTimer = undefined
    await refreshSnap($)
    return next(e)
  })

  // A request has just been sent: that is when the cache's hour starts.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) await touch($)
    return yield* next(e)
  })

  on('session.measure', async ($, e, next) => {
    await refreshSnap($)
    return next(e)
  })

  // The context was replaced: the new prefix is cold until the next request writes it.
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      remindTimer?.cancel()
      remindTimer = undefined
      pingTimer?.cancel()
      pingTimer = undefined
      await update($, lastRequestAt, () => 0)
      await update($, isReminding, () => false)
    }
    return r
  })

  on('command.run', { command: ['warm', 'cache-panel'] }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === '') {
      await openPanel($)
      return {}
    }
    if (arg === 'off' || arg === 'stop') {
      if ((await read($, warm)) === null) return { text: 'Keep-warm is not running' }
      await endWarm($, 'stopped')
      return {}
    }
    const hours = parseHours(arg)
    if (hours === null) return { text: `Usage: /warm [hours 0-${MAX_HOURS} | off]` }
    await startWarm($, hours)
    return {}
  })

  // The one-line reminder, or the keep-warm status. Nothing is drawn the rest of the time.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const w = await read($, warm)
    const now = await read($, nowAt)
    const last = await read($, lastRequestAt)
    const reminding = await read($, isReminding)
    const showReminder = w === null && reminding && last > 0 && now - last < TTL_MS
    if (e.props.hasSurvey || (w === null && !showReminder)) return next(e)

    const below = await next(e)
    const { Box, Button } = $.ui.resolve(e)
    const short = e.props.bodyColumns < 40
    const label =
      w !== null
        ? `warm ${fmtDur(w.deadline - now)}`
        : short
          ? `cache ${fmtDur(last + TTL_MS - now)}`
          : `cache cools in ${fmtDur(last + TTL_MS - now)}`
    const mine = <Button key="open" label={label} onPress={() => void openPanel($)} />

    return below ? (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    ) : (
      mine
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    // Text fields exist in the terminal and the Desktop app only.
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const s = await read($, snap)
    const now = await read($, nowAt)
    const last = await read($, lastRequestAt)
    const w = await read($, warm)
    const typed = await read($, hoursText)
    const lastNote = await read($, note)

    const price = priceOf(s.model)
    const basis = s.hasLimits ? 'subscription' : 'api'
    const parsed = parseHours(typed)
    const hours = parsed ?? DEFAULT_HOURS
    const isCold = last > 0 && now - last >= TTL_MS
    const plan = makePlan({ ctx: s.ctx, price, basis, hours, lastReq: last, now, isWarm: !isCold })
    // Short enough to fit above the prompt, so the arrow keys move focus and do not scroll.
    const narrow = e.props.bodyColumns < 44

    const cacheText = isCold
      ? `cold ${fmtDur(now - last - TTL_MS)}`
      : last > 0
        ? `${fmtDur(last + TTL_MS - now)} left`
        : 'no request'
    const quota = s.fiveHour !== null ? ` · 5h ${s.fiveHour}%` : ''
    const guess = price.isGuess ? ' · guessed' : ''

    let advice: string
    if (parsed === null) advice = `Hours: 0 to ${MAX_HOURS}`
    else if (isCold) advice = 'Cache is cold: just send.'
    else if (s.ctx < thresholdTokens(price)) advice = 'Small context: do nothing.'
    else advice = narrow ? `Best: ${pickLabel(plan.recommended)}` : `Best: ${pickLabel(plan.recommended)} (warm wins to ~${plan.breakEvenHours.toFixed(1)}h)`
    const legend = basis === 'subscription' ? '~ token-equiv (plan) · $ API price' : '~ token-equiv · $ API price'

    return (
      <Box flexDirection="column">
        {narrow ? (
          <Box flexDirection="column">
            <Text bold>{`${price.id} · ctx ${fmtK(s.ctx)}`}</Text>
            <Text>{`cache ${cacheText}${quota}${guess}`}</Text>
          </Box>
        ) : (
          <Text bold>{`${price.id} · ctx ${fmtK(s.ctx)} · cache ${cacheText}${quota}${guess}`}</Text>
        )}
        <Input
          key="hours"
          label="Away (hours)"
          placeholder={String(DEFAULT_HOURS)}
          value={typed}
          submitLabel="warm"
          onInput={(v: string) => void update($, hoursText, () => v)}
          onSubmit={(v: string) => {
            const h = parseHours(v)
            if (h === null) $.ui.toast(`Enter hours between 0 and ${MAX_HOURS}`, { timeoutMs: TOAST_MS })
            else void startWarm($, h)
          }}
        />
        {optionRows(plan, !isCold, narrow).map(line => (
          <Text>{line}</Text>
        ))}
        {!narrow && <Text dimColor>{lastNote !== '' ? lastNote : legend}</Text>}
        <Text>{advice}</Text>
        {w !== null && (
          <Button
            key="stop"
            label={`Stop warm (${fmtDur(w.deadline - now)} left, ${w.pings} ping${w.pings === 1 ? '' : 's'})`}
            autoFocus
            onPress={() => void endWarm($, 'stopped')}
          />
        )}
        {w === null && !isCold && (
          <Button
            key="warm"
            label={`Keep warm ${fmtHours(hours)}`}
            autoFocus
            onPress={() => {
              if (parsed === null) $.ui.toast(`Enter hours between 0 and ${MAX_HOURS}`, { timeoutMs: TOAST_MS })
              else void startWarm($, parsed)
            }}
          />
        )}
        {!isCold && <Button key="once" label="Ping once (+1h)" onPress={() => void doPing($, 'once')} />}
        <Button key="compact" label="Compact now" onPress={() => void $.clock.after(50, () => void compactNow($))} />
        {isCold && <Button key="close" label="Dismiss" autoFocus onPress={() => void $.ui.close({ id: PANE })} />}
      </Box>
    )
  })
}

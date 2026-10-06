import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Revealed, Verdicts } from '../types'
import { analyze, bar, chunkMarkdown, hasTags, maskDeep, maskPlain, parseTerms, segments, stripTags, tidy, tokens, units } from './detect'
import type { Span, Terms, Unit } from './detect'

const enabled = atom({ plugin: 'screen-guard', key: 'enabled' } as const, false)
const verdicts = atom({ plugin: 'screen-guard', key: 'verdicts' } as const, {} as Verdicts)
const revealed = atom({ plugin: 'screen-guard', key: 'revealed' } as const, {} as Revealed)

const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
// Below this a soft candidate is shown. Strict on purpose: unsure means masked.
const THRESHOLD = 0.2
const BATCH = 40
const RETRY_MS = 30_000
const MAX_CACHE = 5000

const QUESTION =
  'A teacher is screen-sharing this text live to a class of students. Does `candidate`, as used in `snippet`, ' +
  'name a real private person (client, student, colleague, family member) or a real private company or organisation ' +
  'whose identity the teacher should hide from the students?'
const CRITERIA = {
  true: 'A real individual\'s name, nickname or handle, or a specific private company, client, school or organisation.',
  false:
    'A public software product, tool, programming term, famous brand or public platform, a generic word or role, ' +
    'a fictional demo placeholder, or text that is not a name at all.',
}

const TERMS_PATH = '.config/screen-guard/terms.txt'

const TAG_PROMPT = [
  '# Screen sharing is on',
  'The user is sharing this screen with an audience. In your prose replies, wrap every real private',
  "person's name (client, student, colleague, family) and every private company, client or organisation",
  'name in ⟦ and ⟧, for example ⟦王小明⟧ or ⟦Acme Trading⟧. Tag each occurrence. Do not tag public',
  'products, tools, platforms, famous brands, or yourself. Never put ⟦ or ⟧ inside tool inputs, file',
  'contents, code or commands. The brackets are hidden from the screen; do not mention them.',
].join('\n')
// Path prefixes (one per line) whose sessions never send text to a third party.
const LOCAL_ONLY_PATH = '.config/screen-guard/local-only.txt'
const OLLAMA_URL = 'http://localhost:11434/api/generate'
// Override with SCREEN_GUARD_OLLAMA_MODEL; the default is the model this was tuned on.
const DEFAULT_OLLAMA_MODEL = 'qwen3.6:35b-a3b'

type Batch = Array<[string, string]>
type Engine = 'jev' | 'local'

let terms: Terms = { mask: [], allow: new Set() }
const queue = new Map<string, string>() // term -> context snippet
const inflight = new Set<string>()
const failedAt = new Map<string, number>()
let known: Verdicts = {}
let apiKey: string | undefined
let ollamaModel = DEFAULT_OLLAMA_MODEL
let engine: Engine = 'jev'
let forcedLocal = false

function statusText() {
  const route = forcedLocal ? '本機（路徑鎖定）' : engine === 'local' ? '本機' : 'JEV'
  return `遮蔽 ON · ${route}`
}

async function loadLocalOnly($: any, cwd: string) {
  const home = await $.env.get('HOME')
  try {
    const raw: string = await $.fs.read(`${home}/${LOCAL_ONLY_PATH}`)
    forcedLocal = raw
      .split('\n')
      .map(l => l.trim().replace(/^~/, home ?? '~'))
      .filter(l => l && !l.startsWith('#'))
      .some(prefix => cwd === prefix || cwd.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'))
  } catch {
    forcedLocal = false
  }
}

async function loadTerms($: any) {
  const home = await $.env.get('HOME')
  try {
    terms = parseTerms(await $.fs.read(`${home}/${TERMS_PATH}`))
  } catch {
    terms = { mask: [], allow: new Set() }
  }
}

// Strict: hard hits always; soft hits unless JEV scored them low.
function decider(v: Verdicts, shown: Revealed) {
  return (s: Span) => {
    if (shown[s.term]) return false
    if (s.hard) return true
    const p = v[s.term]
    if (p === undefined) {
      const now = Date.now()
      if (!inflight.has(s.term) && now - (failedAt.get(s.term) ?? 0) > RETRY_MS) queue.set(s.term, s.context)
      return true
    }
    return p >= THRESHOLD
  }
}

async function masker($: any) {
  const v = await read($, verdicts)
  const shown = await read($, revealed)
  const decide = decider(v, shown)
  const plain = (s: string) => {
    const { clean, spans } = analyze(s, terms)
    return maskPlain(clean, spans, decide)
  }
  return { decide, plain }
}

async function askJev($: any, batch: Batch): Promise<Verdicts> {
  if (!apiKey) throw new Error('no key')
  const questions: Record<string, unknown> = {}
  batch.forEach(([t, ctx], i) => {
    questions[`q${i}`] = {
      type: 'noul',
      instructions: { candidate: t, snippet: ctx, question: QUESTION },
      criteria: CRITERIA,
    }
  })
  const res = await $.http.fetch(JEV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state: 'Screen-share privacy review', questions }),
  })
  if (!res.ok) throw new Error(`jev ${res.status}`)
  const answers = JSON.parse(res.text).answers as Record<string, { noul?: number }>
  const got: Verdicts = {}
  batch.forEach(([t], i) => {
    const p = answers[`q${i}`]?.noul
    if (typeof p === 'number') got[t] = p
  })
  return got
}

// Local fallback: one Ollama call, a keyed JSON schema so no item can shift rows.
async function askLocal($: any, batch: Batch): Promise<Verdicts> {
  const items = batch.map(([t, c], i) => ({ id: `c${i}`, candidate: t, snippet: c }))
  const prompt =
    'A teacher is screen-sharing text live to students. For each item, score 0-100 how likely `candidate` ' +
    '(as used in `snippet`) names a real private person (client, student, colleague, family) or a real private ' +
    'company/organisation that must be hidden. Score low for public software products, tools, programming terms, ' +
    'famous brands, public platforms, generic words or roles, or text that is not a name.\nItems:\n' +
    JSON.stringify(items) +
    '\nReturn a JSON object mapping every item id to its integer score.'
  const res = await $.http.fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel,
      prompt,
      stream: false,
      think: false,
      keep_alive: '2h',
      options: { temperature: 0 },
      format: {
        type: 'object',
        properties: Object.fromEntries(items.map(it => [it.id, { type: 'integer', minimum: 0, maximum: 100 }])),
        required: items.map(it => it.id),
      },
    }),
  })
  if (!res.ok) throw new Error(`ollama ${res.status}`)
  const scores = JSON.parse(JSON.parse(res.text).response) as Record<string, number>
  const got: Verdicts = {}
  batch.forEach(([t], i) => {
    const v = scores[`c${i}`]
    if (typeof v === 'number') got[t] = v / 100
  })
  return got
}

async function flush($: any) {
  if (queue.size === 0 || inflight.size > 0) return
  const batch: Batch = [...queue.entries()].slice(0, BATCH)
  for (const [t] of batch) {
    queue.delete(t)
    inflight.add(t)
  }
  try {
    let got: Verdicts | null = null
    // Cloud only when this session allows it; any JEV failure falls through to the local model.
    if (!forcedLocal && engine === 'jev') got = await askJev($, batch).catch(() => null)
    if (got === null) got = await askLocal($, batch).catch(() => null)
    if (got === null) throw new Error('no judge reachable')
    for (const [t] of batch) if (got[t] === undefined) failedAt.set(t, Date.now())
    known = { ...known, ...got }
    const keys = Object.keys(known)
    if (keys.length > MAX_CACHE) for (const k of keys.slice(0, keys.length - MAX_CACHE)) delete known[k]
    const fresh = got
    await update($, verdicts, v => ({ ...v, ...fresh }))
    await $.store.set('verdicts', known)
  } catch {
    for (const [t] of batch) failedAt.set(t, Date.now())
    $.ui.status(`${statusText()}（判讀不可用，全從嚴）`)
  } finally {
    for (const [t] of batch) inflight.delete(t)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mask',
      description: 'Screen-share guard: toggle masking (/mask on|off|local|cloud|reset|reload)',
    })
    await loadTerms($)
    await loadLocalOnly($, e.cwd)
    engine = (await $.store.get('engine')) === 'local' ? 'local' : 'jev'
    const stored = ((await $.store.get('verdicts')) ?? {}) as Record<string, number>
    known = stored
    await update($, verdicts, () => stored)
    const wasOn = (await $.store.get('enabled')) === true
    await update($, enabled, () => wasOn)
    $.ui.status(wasOn ? statusText() : undefined)

    apiKey = await $.env.get('TYPESAFE_API_KEY')
    ollamaModel = (await $.env.get('SCREEN_GUARD_OLLAMA_MODEL')) || DEFAULT_OLLAMA_MODEL
    $.clock.every(120, () => void flush($))

    return next(e)
  })

  // While masking is on, Claude also tags private names itself; the renderer turns tags into bars.
  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if (!(await read($, enabled))) return out
    return { sections: [...out.sections, { id: 'screen-guard:tags', text: TAG_PROMPT, scope: 'session' as const }] }
  })

  // Tags are for the screen only: strip them from anything a tool would write or run.
  on('tool.call', async ($, e, next) => {
    // A call's arguments sit on the event itself (e.command, e.file_path, e.content).
    if (!hasTags(e)) return next(e)
    return next(maskDeep(e, s => stripTags(s).clean) as typeof e)
  })

  on('command.run', { command: 'mask' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'reset') {
      await update($, revealed, () => ({}))
      return { text: '已重新遮住所有手動解遮的項目。' }
    }
    if (arg === 'reload') {
      await loadTerms($)
      await loadLocalOnly($, await $.session.cwd())
      return {
        text: `已重讀詞表：遮蔽 ${terms.mask.length} 條、放行 ${terms.allow.size} 條；判讀走${forcedLocal ? '本機（路徑鎖定）' : engine === 'local' ? '本機' : 'JEV'}。`,
      }
    }
    if (arg === 'local' || arg === 'cloud') {
      engine = arg === 'local' ? 'local' : 'jev'
      await $.store.set('engine', engine)
      if (await read($, enabled)) $.ui.status(statusText())
      if (forcedLocal && engine === 'jev') return { text: '這個資料夾在 local-only 清單內，仍維持本機判讀。' }
      return { text: engine === 'local' ? `改用本機模型判讀（${ollamaModel}），文字不出這台機器。` : '改用 JEV 判讀；JEV 失敗時自動退回本機模型。' }
    }
    const cur = await read($, enabled)
    const on_ = arg === 'on' ? true : arg === 'off' ? false : !cur
    await update($, enabled, () => on_)
    await $.store.set('enabled', on_)
    if (!on_) await update($, revealed, () => ({}))
    $.ui.status(on_ ? statusText() : undefined)
    return { text: on_ ? '螢幕遮蔽已開啟。點遮罩可解遮該詞，/mask reset 全部重新遮住。' : '螢幕遮蔽已關閉。' }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!(await read($, enabled))) {
      // Masking off: older tagged replies still drop their brackets.
      const { clean } = stripTags(e.props.text)
      return next(clean === e.props.text ? e : { ...e, props: { ...e.props, text: clean } })
    }
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    try {
      const { decide } = await masker($)
      const { clean: src, spans } = analyze(e.props.text, terms)
      const plainProps = src === e.props.text ? e : { ...e, props: { ...e.props, text: src } }
      if (!spans.some(decide)) return next(plainProps)
      const reveal = (term: string) => void update($, revealed, r => ({ ...r, [term]: true }))
      let n = 0
      const row = (line: Unit, raw: boolean) => {
        const segs = segments(line.text, spans.filter(sp => sp.start >= line.start && sp.end <= line.end).map(sp => ({ ...sp, start: sp.start - line.start, end: sp.end - line.start })), decide)
        const indent = raw ? 0 : (line.text.match(/^\s*/)?.[0].length ?? 0)
        const heading = !raw && /^\s*#{1,6}\s/.test(line.text)
        return (
          <Box key={`r${n++}`} flexDirection="row" flexWrap="wrap" paddingLeft={indent}>
            {segs.map((sg, i) => {
              if (sg.span) {
                const term = sg.span.term
                return <Button key={`b${n++}`} plain label={bar(term)} onPress={() => reveal(term)} />
              }
              const t = raw ? sg.text : tidy(sg.text, i === 0)
              return tokens(t).map(tk => (
                <Text key={`t${n++}`} bold={heading}>
                  {tk}
                </Text>
              ))
            })}
          </Box>
        )
      }
      const out: unknown[] = []
      let clean: string[] = []
      const flushClean = () => {
        if (!clean.length) return
        for (const c of chunkMarkdown(clean.join('\n'))) out.push(<Markdown key={`m${n++}`} text={c} />)
        clean = []
      }
      for (const unit of units(src)) {
        const masked = spans.some(sp => decide(sp) && sp.start < unit.end && sp.end > unit.start)
        if (!masked) {
          clean.push(unit.text)
          continue
        }
        flushClean()
        // A span crossing lines (a key block) hides the whole unit.
        if (spans.some(sp => decide(sp) && sp.start < unit.end && sp.end > unit.start && (sp.start < unit.start || sp.end > unit.end))) {
          out.push(<Text key={`x${n++}`}>{bar('xxxxxxxxxx')}</Text>)
          continue
        }
        for (const line of unit.lines) out.push(row(line, unit.raw))
      }
      flushClean()
      return (
        <Box flexDirection="row">
          <Text>{e.props.isFirstOfReply ? '⏺ ' : '  '}</Text>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            {out}
          </Box>
        </Box>
      )
    } catch {
      return <Text dimColor>⏺ ‹此段已遮蔽›</Text>
    }
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const { plain } = await masker($)
    return next({ ...e, props: { ...e.props, text: plain(e.props.text) } })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const { plain } = await masker($)
    return next({
      ...e,
      props: {
        ...e.props,
        input: maskDeep(e.props.input, plain),
        ...(e.props.output === undefined ? {} : { output: maskDeep(e.props.output, plain) }),
      },
    })
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const { plain } = await masker($)
    return next({ ...e, props: { ...e.props, output: maskDeep(e.props.output, plain) } })
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)
    const { plain } = await masker($)
    return next({
      ...e,
      props: { ...e.props, calls: e.props.calls.map(c => ({ ...c, input: maskDeep(c.input, plain) })) },
    })
  })
}

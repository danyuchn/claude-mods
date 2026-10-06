import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { detect, maskMarkdown, maskPlain, parseTerms } from './detect'

type World = { jev?: Record<string, number>; local?: Record<string, number>; jevDown?: boolean; localOnly?: string }
const calls: string[] = []

function world(on: On, jev?: Record<string, number>, opts: World = {}) {
  calls.length = 0
  mock.store(on)
  mock.env(on, { HOME: '/nowhere', TYPESAFE_API_KEY: 'test' })
  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.read', (_$, e) =>
    e.path.endsWith('local-only.txt') && opts.localOnly ? { value: opts.localOnly } : { deny: 'missing' },
  )
  on('ui.status', () => ({ value: undefined }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>ENGINE</Text>
  })
  on('http.fetch', (_$, e) => {
    calls.push(e.url)
    if (e.url.includes('11434')) {
      const body = JSON.parse(String(e.init?.body))
      const ids = body.format.required as string[]
      const items = JSON.parse(body.prompt.split('Items:\n')[1].split('\nReturn')[0]) as Array<{ id: string; candidate: string }>
      const out: Record<string, number> = {}
      for (const it of items) out[it.id] = opts.local?.[it.candidate] ?? 90
      expect(ids.length).toBe(items.length)
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ response: JSON.stringify(out) }) } } as never
    }
    if (opts.jevDown) return { value: { status: 503, ok: false, headers: {}, text: '' } } as never
    const qs = JSON.parse(String(e.init?.body)).questions as Record<string, { instructions: { candidate: string } }>
    const answers: Record<string, { type: string; noul: number }> = {}
    for (const [k, q] of Object.entries(qs)) answers[k] = { type: 'noul', noul: jev?.[q.instructions.candidate] ?? 0.9 }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers }) } } as never
  })
  return clock
}

const terms = parseTerms('Morwenna\n!Claude Code\n')

test('hard hits are found and masked', async () => {
  const text = '寄到 wang@example.com，手機 0912-345-678，身分證 A123456789，key sk-ant-abcdefghijklmnopqrstu'
  const spans = detect(text, terms)
  const out = maskPlain(text, spans, s => s.hard)
  expect(out.includes('wang@example.com')).toBe(false)
  expect(out.includes('0912-345-678')).toBe(false)
  expect(out.includes('A123456789')).toBe(false)
  expect(out.includes('sk-ant-')).toBe(false)
})

test('soft candidates: names, orgs, terms; allowlist respected', async () => {
  const text = '明天跟王小明在藍鯨工坊科技股份有限公司開會，陳老師說 Morwenna 那邊要用 Claude Code。'
  const got = detect(text, terms).map(s => s.term)
  expect(got.includes('王小明')).toBe(true)
  expect(got.some(t => t.includes('藍鯨工坊科技'))).toBe(true)
  expect(got.some(t => t.startsWith('陳'))).toBe(true)
  expect(got.includes('Morwenna')).toBe(true)
  expect(got.some(t => t.includes('Claude'))).toBe(false)
})

test('common words are not name candidates', async () => {
  const text = '這個程式的方法很簡單，連結到紀錄檔，謝謝。如何提高效率？'
  expect(detect(text, terms).length).toBe(0)
})

test('markdown masks outside code are pressable links, inside code plain', async () => {
  const text = '找 Morwenna 確認\n\n```\nemail: a@b.co\n```'
  const spans = detect(text, terms)
  const { text: md, links } = maskMarkdown(text, spans, () => true)
  expect(links.size).toBe(1)
  expect(md.includes('Morwenna')).toBe(false)
  expect(md.includes('a@b.co')).toBe(false)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`off by default draws the engine's own (${surface})`, async ($, on) => {
    world(on)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount({
      plugin: 'screen-guard',
      surface,
      component: 'AssistantMessage',
      requestId: 'm1',
      props: { text: '找 wang@example.com', isFirstOfReply: true },
    })
    expect(JSON.stringify(await ui.drawn()).includes('█')).toBe(false)
  })

  test(`on: masks and a press reveals (${surface})`, async ($, on) => {
    const clock = world(on, { 王小明: 0.8, 請聯絡: 0.01 })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.command.run({
      command: 'mask',
      args: 'on',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })
    const ui = await $.ui.mount({
      plugin: 'screen-guard',
      surface,
      component: 'AssistantMessage',
      requestId: 'm2',
      props: { text: '請聯絡王小明 wang@example.com', isFirstOfReply: true },
    })
    const before = JSON.stringify(await ui.drawn())
    expect(before.includes('wang@example.com')).toBe(false)
    expect(before.includes('王小明')).toBe(false)
    const bars = await ui.findAll({ type: 'Button' })
    expect(bars.length).toBe(2)
    await ui.press({ key: bars[0].key! })
    // Rows are drawn one token per element, so read the drawn text back joined.
    const after = JSON.stringify(await ui.drawn()).replace(/"\]\},\{"type":"Text","props":\{"bold":false\},"children":\["/g, '')
    expect(after.includes('王小明')).toBe(true)
    expect(after.includes('wang@example.com')).toBe(false)
    expect((await ui.findAll({ type: 'Button' })).length).toBe(1)
  })

  test(`JEV clears a low-scored candidate (${surface})`, async ($, on) => {
    const clock = world(on, { 林大同: 0.05 })
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    await $.command.run({
      command: 'mask',
      args: 'on',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 120 },
    })
    const ui = await $.ui.mount({
      plugin: 'screen-guard',
      surface,
      component: 'AssistantMessage',
      requestId: 'm3',
      props: { text: '林大同 是一款遊戲', isFirstOfReply: true },
    })
    expect(JSON.stringify(await ui.drawn()).includes('林大同')).toBe(false)
    await clock.advance(200)
    expect(JSON.stringify(await ui.drawn()).includes('█')).toBe(false)
  })
}

async function maskOn($: any, args = 'on') {
  await $.command.run({ command: 'mask', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
}

async function shownAfterJudge($: any, clock: any, name: string) {
  const ui = await $.ui.mount({
    plugin: 'screen-guard',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'x' + name,
    props: { text: `${name} 是一款遊戲`, isFirstOfReply: true },
  })
  expect(JSON.stringify(await ui.drawn()).includes(name)).toBe(false)
  await clock.advance(200)
  // Shown = no mask left; the engine then draws the row as its own.
  return !JSON.stringify(await ui.drawn()).includes('█')
}

test('JEV down falls back to the local model', async ($, on) => {
  const clock = world(on, undefined, { jevDown: true, local: { 林大同: 5 } })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await maskOn($)
  expect(await shownAfterJudge($, clock, '林大同')).toBe(true)
  expect(calls.some(u => u.includes('typesafe'))).toBe(true)
  expect(calls.some(u => u.includes('11434'))).toBe(true)
})

test('/mask local never calls JEV', async ($, on) => {
  const clock = world(on, undefined, { local: { 林大同: 5 } })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await maskOn($)
  await maskOn($, 'local')
  expect(await shownAfterJudge($, clock, '林大同')).toBe(true)
  expect(calls.some(u => u.includes('typesafe'))).toBe(false)
})

test('a local-only path locks the session to the local model', async ($, on) => {
  const clock = world(on, undefined, { local: { 林大同: 5 }, localOnly: '# clients\n/work/clients/secret\n' })
  await $.session.start({ cwd: '/work/clients/secret/notes', surface: 'terminal', isInteractive: true })
  await maskOn($)
  await maskOn($, 'cloud')
  expect(await shownAfterJudge($, clock, '林大同')).toBe(true)
  expect(calls.some(u => u.includes('typesafe'))).toBe(false)
})

test('local model unsure keeps it masked', async ($, on) => {
  const clock = world(on, undefined, { jevDown: true, local: { 林大同: 55 } })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await maskOn($)
  expect(await shownAfterJudge($, clock, '林大同')).toBe(false)
})

test('a masked table keeps its rows; English names beside CJK punctuation are caught', async ($, on) => {
  world(on, undefined, { jevDown: true, local: {} })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await maskOn($)
  const text = '## 客戶\n\n| 客戶 | 窗口 |\n|---|---|\n| 藍鯨工坊科技股份有限公司 | wang@example.com |\n\n- 已封存：Brixton、Quillon、Vesper。\n- 一般說明沒有名字。'
  const ui = await $.ui.mount({ plugin: 'screen-guard', surface: 'terminal', component: 'AssistantMessage', requestId: 'tb', props: { text, isFirstOfReply: true } })
  const drawn = JSON.stringify(await ui.drawn())
  for (const leak of ['藍鯨工坊科技', 'wang@example.com', 'Brixton', 'Quillon', 'Vesper']) expect(drawn.includes(leak)).toBe(false)
  expect(drawn.includes('一般說明沒有名字')).toBe(true)
  expect(drawn.includes('mask.invalid')).toBe(false)
})

test('model tags: masked when on, brackets stripped when off', async ($, on) => {
  world(on, undefined, { jevDown: true, local: {} })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const text = '明天找 ⟦Zorblat⟧ 對一下 ⟦藍鯨工坊⟧ 的流程'
  const off = await $.ui.mount({ plugin: 'screen-guard', surface: 'terminal', component: 'AssistantMessage', requestId: 'tg0', props: { text, isFirstOfReply: true } })
  const offDrawn = JSON.stringify(await off.drawn())
  expect(offDrawn.includes('⟦')).toBe(false)
  await maskOn($)
  const ui = await $.ui.mount({ plugin: 'screen-guard', surface: 'terminal', component: 'AssistantMessage', requestId: 'tg1', props: { text, isFirstOfReply: true } })
  const drawn = JSON.stringify(await ui.drawn())
  for (const leak of ['Zorblat', '藍', '⟦', '⟧']) expect(drawn.includes(leak)).toBe(false)
  expect((await ui.findAll({ type: 'Button' })).length).toBe(2)
})

test('tags never reach a tool call', async ($, on) => {
  world(on, undefined, {})
  let seen = ''
  on('tool.call', (_$, e) => {
    seen = JSON.stringify(e)
    return { result: {} } as never
  })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'echo ⟦王小明⟧' } as never)
  expect(seen.includes('王小明')).toBe(true)
  expect(seen.includes('⟦')).toBe(false)
})

test('prompt section only while masking is on', async ($, on) => {
  world(on, undefined, {})
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }) as never)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const args = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never
  const before = await $.prompt.compose(args)
  expect(JSON.stringify(before).includes('screen-guard:tags')).toBe(false)
  await maskOn($)
  const after = await $.prompt.compose(args)
  expect(JSON.stringify(after).includes('screen-guard:tags')).toBe(true)
})

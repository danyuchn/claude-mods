// Local, synchronous candidate detection. Hard hits are always masked;
// soft hits (names, orgs) are masked until JEV clears them.

export type Kind = 'secret' | 'contact' | 'id' | 'person' | 'org' | 'term'
export type Span = {
  start: number
  end: number
  term: string
  kind: Kind
  hard: boolean
  context: string
}

export const LABEL: Record<Kind, string> = {
  secret: '‹金鑰›',
  contact: '‹聯絡›',
  id: '‹證號›',
  person: '‹人名›',
  org: '‹組織›',
  term: '‹機敏›',
}

type Rule = { re: RegExp; kind: Kind; group?: number }

// Patterns ported from pii-guard's Taiwan recognizers plus common API key shapes.
const HARD: Rule[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, kind: 'secret' },
  { re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, kind: 'secret' },
  { re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, kind: 'secret' },
  { re: /\bwhsec_[A-Za-z0-9]{10,}/g, kind: 'secret' },
  { re: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, kind: 'secret' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, kind: 'secret' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, kind: 'secret' },
  { re: /\bAIza[0-9A-Za-z_-]{35}/g, kind: 'secret' },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, kind: 'secret' },
  { re: /\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/g, kind: 'secret', group: 1 },
  {
    re: /(?:password|passwd|pwd|密碼|密码|token|secret|api[_-]?key|驗證碼)["']?\s*(?:是|為)?\s*[:=：]\s*["']?([^\s"',;]{4,})/gi,
    kind: 'secret',
    group: 1,
  },
  { re: /(?<![A-Za-z0-9.@_%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9])/g, kind: 'contact' },
  { re: /\+886[-\s]?9\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, kind: 'contact' },
  { re: /\+66[-\s]?\d{1,2}[-\s]?\d{3}[-\s]?\d{4}/g, kind: 'contact' },
  { re: /(?<!\d)09\d{2}[-\s]?\d{3}[-\s]?\d{3}(?!\d)/g, kind: 'contact' },
  { re: /\(0[2-8]\)\s*\d{3,4}[-\s]?\d{4}|(?<!\d)0[2-8]-\d{7,8}(?!\d)/g, kind: 'contact' },
  { re: /(?<![A-Za-z0-9])[A-Z][12A-D89]\d{8}(?![A-Za-z0-9])/g, kind: 'id' },
  { re: /(?<!\d)\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}(?!\d)/g, kind: 'id' },
  {
    re: /(?:(?:台|臺)(?:北|中|南|東)市|新北市|桃園市|高雄市|基隆市|新竹[市縣]|嘉義[市縣]|苗栗縣|彰化縣|南投縣|雲林縣|屏東縣|宜蘭縣|花蓮縣|(?:台|臺)東縣|澎湖縣|金門縣|連江縣)[^\s，。,]{2,30}?\d+(?:之\d+)?號(?:\d+樓)?/g,
    kind: 'contact',
  },
  { re: /(?<![\d.])(?!(?:127|10|0)\.)(?!192\.168\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, kind: 'contact' },
]

// High-entropy token: long, mixes upper, lower and digits. Git SHAs are lowercase hex, so they pass.
const ENTROPY = /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g

const SURNAMES =
  '陳林黃張李王吳劉蔡楊許鄭謝洪郭邱曾廖賴徐周葉蘇莊呂江何蕭羅高潘簡朱鍾游彭詹胡施沈余盧梁趙顏柯翁魏孫戴范宋方鄧杜傅侯曹薛丁卓阮馬董溫唐藍蔣石古紀姚連馮歐湯黎田白涂尤巫韓龔嚴袁鐘鄒'

// Two-character words that start or end on a surname character but are not names.
const STOP = new Set(
  (
    '許多 許可 允許 也許 或許 期許 曾經 未曾 不曾 周末 周邊 周圍 周期 周年 每周 四周 周遭 江湖 朱紅 ' +
    '高度 高級 高手 高效 高速 高中 高雄 高峰 高頻 高層 高價 高達 高於 最高 提高 很高 太高 更高 較高 拉高 偏高 調高 高亮 ' +
    '方法 方式 方向 方案 方便 方面 對方 雙方 地方 官方 一方 方塊 方針 方形 處方 配方 前方 後方 下方 上方 我方 他方 遠方 東方 西方 ' +
    '何時 如何 任何 為何 幾何 何必 何況 何謂 何處 何種 施作 施工 實施 措施 設施 施行 施加 ' +
    '程式 連結 連線 連接 連續 連到 連上 串連 紀錄 紀念 紀律 簡單 簡化 簡報 簡介 簡短 簡潔 精簡 謝謝 感謝 致謝 ' +
    '馬上 尤其 嚴格 嚴重 黃色 黃金 藍色 藍圖 溫度 溫和 白話 白色 空白 明白 古典 石頭 余額 唐突 湯匙 田野 董事 鐘頭 時鐘 ' +
    '陳述 陳列 林立 森林 樹林 范圍 宋體 歐洲 歐美 洪水 莊重 胡亂 葉子 羅列 韓國 杜絕 卓越 丁點 傅立 ' +
    '一張 主張 擴張 緊張 誇張 開張 紙張 張數 張貼 李子 行李 王國 王牌 王道 國王 吳語 劉海 蔡司 楊柳 鄭重 ' +
    '邱比 郭外 廖廖 賴床 依賴 信賴 仰賴 徐徐 蘇打 呂宋 蕭條 潘朵 鍾愛 鍾情 游戲 游標 上游 下游 彭湃 詹姆 胡椒 ' +
    '沈默 沈重 沈浸 盧比 梁柱 趙氏 顏色 顏料 柯南 翁 魏 孫子 戴上 佩戴 愛戴 鄧 杜鵑 傅 侯 曹 薛 阮 溫暖 唐朝 ' +
    '蔣 姚 馮 黎明 涂 尤 巫師 龔 嚴謹 袁 鐘 鄒 連帶 連動 連鎖 紀元 古老 石油 田地 白天 白板 方才 高興 高低 馬達 馬虎'
  ).split(' '),
)
const FUNC = new Set('的了是在和與及說也就都要會能把被讓給從到對為以並或而但不沒很太更最這那個些上下中裡外前後時年月日請可已用將再又還跟找於'.split(''))
const QUANT = new Set('一二兩三四五六七八九十幾每這那多0123456789'.split(''))
const TITLES =
  '先生|小姐|女士|老師|經理|總監|董事長|總經理|執行長|醫師|醫生|律師|會計師|教授|同學|博士|主任|院長|校長|副總|協理|特助|學姊|學長|學妹|學弟|太太|阿姨|教練'
const TITLE_RE = new RegExp(`([\\u4e00-\\u9fff]{1,3})(?:${TITLES})`, 'g')
const ORG_SUFFIX =
  /(?:股份有限公司|有限公司|公司|集團|銀行|醫院|診所|大學|學院|法院|事務所|協會|基金會|工作室|實業|控股|證券|保險|顧問|研究院|研究所|管理處|委員會)/g
const ORG_EN =
  /\b(?:[A-Z][A-Za-z&.-]+\s){1,4}(?:Inc|Ltd|LLC|Corp|Co|Pte|GmbH|Holdings|Capital|Group|Partners|Advisors|Ventures|Asset Management)\b\.?/g
const EN_PAIR = /\b[A-Z][a-z]{1,15}\s[A-Z][a-z]{1,15}\b/g
// In mixed Chinese/English text, a capitalised word next to Chinese is usually a name.
// CJK ideographs plus CJK and full-width punctuation (、，：（）).
const CJK_CTX = '[\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef]'
const EN_NEAR_CJK = new RegExp(
  `(?<=${CJK_CTX}\\s?)[A-Z][A-Za-z]{2,15}\\b|\\b[A-Z][A-Za-z]{2,15}(?=\\s?${CJK_CTX})`,
  'g',
)

const isCJK = (c: string | undefined) => !!c && c >= '一' && c <= '鿿'

function contextOf(text: string, start: number, end: number) {
  return text.slice(Math.max(0, start - 60), Math.min(text.length, end + 60))
}

function chineseNames(text: string, out: Span[]) {
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (!SURNAMES.includes(c)) continue
    const prev = text[i - 1]
    const next = text[i + 1]
    if (!isCJK(next) || FUNC.has(next)) continue
    if (prev && (QUANT.has(prev) || STOP.has(prev + c))) continue
    if (STOP.has(c + next)) continue
    let end = i + 2
    const third = text[i + 2]
    if (isCJK(third) && !FUNC.has(third) && !STOP.has(next + third)) end = i + 3
    const term = text.slice(i, end)
    out.push({ start: i, end, term, kind: 'person', hard: false, context: contextOf(text, i, end) })
    i = end - 1
  }
}

export type Terms = { mask: string[]; allow: Set<string> }

export function parseTerms(raw: string): Terms {
  const mask: string[] = []
  const allow = new Set<string>()
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    if (t.startsWith('!')) allow.add(t.slice(1).trim().toLowerCase())
    else mask.push(t)
  }
  mask.sort((a, b) => b.length - a.length)
  return { mask, allow }
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function detect(text: string, terms: Terms): Span[] {
  const all: Span[] = []
  const push = (start: number, end: number, kind: Kind, hard: boolean) => {
    const term = text.slice(start, end)
    if (!term.trim()) return
    if (terms.allow.has(term.toLowerCase())) return
    all.push({ start, end, term, kind, hard, context: hard ? '' : contextOf(text, start, end) })
  }
  const run = (re: RegExp, kind: Kind, hard: boolean, group?: number) => {
    re.lastIndex = 0
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      if (group !== undefined && m[group] !== undefined) {
        const s = m.index + m[0].lastIndexOf(m[group])
        push(s, s + m[group].length, kind, hard)
      } else push(m.index, m.index + m[0].length, kind, hard)
    }
  }

  for (const t of terms.mask) {
    // ASCII terms match whole words only, so "Anne" does not hit "planned".
    const edge = /^[A-Za-z0-9]/.test(t) ? '(?<![A-Za-z0-9])' : ''
    const tail = /[A-Za-z0-9]$/.test(t) ? '(?![A-Za-z0-9])' : ''
    run(new RegExp(edge + escapeRe(t) + tail, 'gi'), 'term', true)
    // Longer ASCII terms also hide handles and paths built on them (MorwennaQ929).
    if (/^[A-Za-z0-9 ._-]{5,}$/.test(t)) run(new RegExp(`[A-Za-z0-9._-]*${escapeRe(t)}[A-Za-z0-9._-]*`, 'gi'), 'term', true)
  }
  for (const r of HARD) run(r.re, r.kind, true, r.group)
  run(ENTROPY, 'secret', true)
  // Org: suffix plus up to 8 preceding name characters, stopping at function words.
  ORG_SUFFIX.lastIndex = 0
  for (let m = ORG_SUFFIX.exec(text); m; m = ORG_SUFFIX.exec(text)) {
    let s = m.index
    while (s > 0 && m.index - s < 8) {
      const c = text[s - 1]
      if (!(isCJK(c) || /[A-Za-z0-9]/.test(c)) || FUNC.has(c)) break
      s--
    }
    if (s < m.index) push(s, m.index + m[0].length, 'org', false)
  }
  run(ORG_EN, 'org', false)
  TITLE_RE.lastIndex = 0
  for (let m = TITLE_RE.exec(text); m; m = TITLE_RE.exec(text)) {
    // Keep only the name part before the title, trimmed of leading function words.
    let s = m.index
    let name = m[1]
    while (name.length && FUNC.has(name[0])) {
      name = name.slice(1)
      s++
    }
    if (name.length) push(s, s + name.length, 'person', false)
  }
  chineseNames(text, all)
  run(EN_PAIR, 'person', false)
  run(EN_NEAR_CJK, 'person', false)

  // Allowlisted phrases shield everything inside them.
  const lower = text.toLowerCase()
  const shield: Array<[number, number]> = []
  for (const a of terms.allow) {
    for (let i = lower.indexOf(a); a && i >= 0; i = lower.indexOf(a, i + a.length)) shield.push([i, i + a.length])
  }
  const shielded = (s: Span) => shield.some(([a, b]) => s.start >= a && s.end <= b)

  // Resolve overlaps: hard beats soft, then longer beats shorter.
  all.sort((a, b) => Number(b.hard) - Number(a.hard) || b.end - b.start - (a.end - a.start))
  const taken: Span[] = []
  for (const s of all) {
    if (terms.allow.has(s.term.toLowerCase()) || shielded(s)) continue
    const hit = taken.find(t => s.start < t.end && t.start < s.end)
    if (!hit) {
      taken.push(s)
      continue
    }
    // A soft span reaching past a hard one widens it: "Morwenna" + "Morwenna Quill" hides both words.
    if (hit.hard && !s.hard && (s.start < hit.start || s.end > hit.end)) {
      hit.start = Math.min(hit.start, s.start)
      hit.end = Math.max(hit.end, s.end)
      hit.term = text.slice(hit.start, hit.end)
    }
  }
  return taken.sort((a, b) => a.start - b.start)
}

export type Decide = (s: Span) => boolean

// Plain-text masking for rows drawn by the engine (prompts, tool rows).
export function maskPlain(text: string, spans: Span[], decide: Decide): string {
  let out = ''
  let at = 0
  for (const s of spans) {
    if (!decide(s)) continue
    out += text.slice(at, s.start) + bar(s.term)
    at = s.end
  }
  return out + text.slice(at)
}

// Code fences and inline code: links do not render there, so masks stay plain.
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const re = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g
  for (let m = re.exec(text); m; m = re.exec(text)) ranges.push([m.index, m.index + m[0].length])
  return ranges
}

// Markdown masking: each mask outside code is a link whose press reveals the term.
export function maskMarkdown(
  text: string,
  spans: Span[],
  decide: Decide,
): { text: string; links: Map<string, string> } {
  const code = codeRanges(text)
  const inCode = (i: number) => code.some(([a, b]) => i >= a && i < b)
  const links = new Map<string, string>()
  let out = ''
  let at = 0
  for (const s of spans) {
    if (!decide(s)) continue
    out += text.slice(at, s.start)
    if (inCode(s.start) || text.slice(s.start, s.end).includes('\n')) out += LABEL[s.kind]
    else {
      const href = `https://mask.invalid/${links.size}`
      links.set(href, s.term)
      out += `[${LABEL[s.kind]}](${href})`
    }
    at = s.end
  }
  return { text: out + text.slice(at), links }
}

// Split markdown into chunks under the Markdown element's 10,000-char bound,
// cutting only between lines outside a code fence.
export function chunkMarkdown(text: string, max = 9000): string[] {
  if (text.length <= max) return [text]
  const chunks: string[] = []
  let cur = ''
  let fence = false
  for (const line of text.split('\n')) {
    if (cur.length + line.length + 1 > max && !fence && cur) {
      chunks.push(cur)
      cur = ''
    }
    if (line.length + 1 > max) {
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max))
      continue
    }
    cur += (cur ? '\n' : '') + line
    if (/^\s*```/.test(line)) fence = !fence
  }
  if (cur) chunks.push(cur)
  return chunks
}

// Walks any tool input/output value, masking every string inside it.
export function maskDeep(v: unknown, mask: (s: string) => string, depth = 0): unknown {
  if (depth > 12) return v
  if (typeof v === 'string') return mask(v)
  if (Array.isArray(v)) return v.map(x => maskDeep(x, mask, depth + 1))
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) o[k] = maskDeep(x, mask, depth + 1)
    return o
  }
  return v
}

export type Seg = { text: string; span?: Span }

const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/

// Display width: CJK and full-width characters take two cells.
export function cells(s: string): number {
  let n = 0
  for (const ch of s) n += WIDE.test(ch) ? 2 : 1
  return n
}

// Splits text into plain pieces and masked spans, keeping the original order.
export function segments(text: string, spans: Span[], decide: Decide): Seg[] {
  const out: Seg[] = []
  let at = 0
  for (const s of spans) {
    if (!decide(s)) continue
    if (s.start > at) out.push({ text: text.slice(at, s.start) })
    out.push({ text: text.slice(s.start, s.end), span: s })
    at = s.end
  }
  if (at < text.length) out.push({ text: text.slice(at) })
  return out
}

// A solid redaction bar roughly as wide as the hidden text.
export function bar(term: string): string {
  return '█'.repeat(Math.max(2, Math.min(10, cells(term))))
}

export type Line = { text: string; start: number; end: number }
export type Unit = Line & { lines: Line[]; raw: boolean }

// Splits markdown into render units: a fenced code block or a table is one unit
// (drawn raw when masked), every other line its own unit.
export function units(text: string): Unit[] {
  const lines: Line[] = []
  let at = 0
  for (const t of text.split('\n')) {
    lines.push({ text: t, start: at, end: at + t.length })
    at += t.length + 1
  }
  const out: Unit[] = []
  const group = (ls: Line[], raw: boolean) =>
    out.push({ text: ls.map(l => l.text).join('\n'), start: ls[0].start, end: ls[ls.length - 1].end, lines: ls, raw })
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^\s*```/.test(l.text)) {
      let j = i + 1
      while (j < lines.length && !/^\s*```/.test(lines[j].text)) j++
      group(lines.slice(i, Math.min(j + 1, lines.length)), true)
      i = j
    } else if (/^\s*\|/.test(l.text)) {
      let j = i
      while (j + 1 < lines.length && /^\s*\|/.test(lines[j + 1].text)) j++
      group(lines.slice(i, j + 1), true)
      i = j
    } else group([l], false)
  }
  return out
}

// Light markdown cleanup for a line drawn as plain text beside redaction bars.
export function tidy(s: string, isStart: boolean): string {
  let t = s.replace(/\*\*|__|`/g, '')
  if (isStart) t = t.replace(/^\s*#{1,6}\s+/, '').replace(/^\s*[-*+]\s+/, '• ').replace(/^\s+/, '')
  return t
}

// Inline tokens for a wrapping row: one per CJK character, one per latin word
// with its trailing spaces, so redaction bars stay where the text was.
export function tokens(s: string): string[] {
  return s.match(/[A-Za-z0-9_.,:;!?'"()\[\]\/@#$%&*+=<>~^-]+\s*|\s+|[^\s]/g) ?? []
}

// Model-side tags: Claude may wrap a private name as ⟦name⟧ (U+27E6/U+27E7).
export const TAG_OPEN = '⟦'
export const TAG_CLOSE = '⟧'
const TAG_RE = /⟦([^⟦⟧\n]{1,80})⟧/g

// Removes the tag characters and returns the tagged spans in the cleaned text.
export function stripTags(text: string): { clean: string; tagged: Span[] } {
  const tagged: Span[] = []
  let clean = ''
  let at = 0
  TAG_RE.lastIndex = 0
  for (let m = TAG_RE.exec(text); m; m = TAG_RE.exec(text)) {
    clean += text.slice(at, m.index)
    const start = clean.length
    clean += m[1]
    tagged.push({ start, end: clean.length, term: m[1], kind: 'person', hard: true, context: '' })
    at = m.index + m[0].length
  }
  clean += text.slice(at)
  // Stray brackets (an unclosed tag) are dropped too, so none reach the screen.
  return { clean: clean.replace(/[⟦⟧]/g, ''), tagged }
}

// Local detection plus the model's own tags; a tagged span wins any overlap.
export function analyze(text: string, terms: Terms): { clean: string; spans: Span[] } {
  const { clean, tagged } = stripTags(text)
  if (!tagged.length) return { clean, spans: detect(clean, terms) }
  const found = detect(clean, terms).filter(s => !tagged.some(t => s.start < t.end && t.start < s.end))
  return { clean, spans: [...found, ...tagged].sort((a, b) => a.start - b.start) }
}

export function hasTags(v: unknown): boolean {
  return JSON.stringify(v ?? '').includes(TAG_OPEN) || JSON.stringify(v ?? '').includes(TAG_CLOSE)
}

import { atom, read, update, type EngineInterface, type Register } from 'claude-code'

import { missionSvg, type Lamp } from './mission'
import type { Book, CheckKind, CheckResult, Checks, Demo, Entry, Flash, Guard, LastBlock } from '../types'

const PANE = 'fixnote'
const TITLE = '糾正筆記'
/** 同分類達到這個次數還沒上鎖，就提醒一次 */
const REPEAT = 3
const DEFAULT_EXTS = [
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte',
  '.py', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php', '.swift', '.c', '.cpp', '.h',
]
/** 防線掃描不看的資料夾：套件、建置產物、測試 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', '.venv', 'venv',
  '__pycache__', '.claude-plugin', 'tests', 'test', '__tests__',
])
const SCAN_LIMIT = 2000
const LOCK_FRAMES = ['ARMING ▱▱▱  上鎖中', 'ARMING ▰▱▱  上鎖中', 'ARMING ▰▰▱  上鎖中', 'ARMING ▰▰▰  上鎖中', 'ARMED  已上鎖']
const STRENGTH: Record<string, string> = {
  擋下: '寫了會被當場擋下',
  抓到: '寫錯時測試會失敗',
  只能提醒: '寫進 CLAUDE.md，不保證',
}

const EMPTY_BOOK: Book = { entries: [], isMissing: true, error: null }
const EMPTY_GUARD: Guard = { counts: {}, paused: [] }
const EMPTY_CHECKS: Checks = { isRunning: false, current: null, configured: ['static'], results: [], ranAt: '' }

// 欄位改了就換 shape 標籤，舊版本存的值會被丟掉，不會讀錯
const draft = atom({ plugin: 'fixnote', key: 'draft' } as const, '', { shape: 'draft-2' })
const book = atom({ plugin: 'fixnote', key: 'book' } as const, EMPTY_BOOK, { shape: 'book-2' })
const guard = atom({ plugin: 'fixnote', key: 'guard' } as const, EMPTY_GUARD, { shape: 'guard-1' })
const demo = atom({ plugin: 'fixnote', key: 'demo' } as const, null as Demo | null, { shape: 'demo-1' })
const flash = atom({ plugin: 'fixnote', key: 'flash' } as const, null as Flash | null, { shape: 'flash-2' })
const lastBlock = atom({ plugin: 'fixnote', key: 'lastBlock' } as const, null as LastBlock | null, {
  shape: 'last-2',
})
const checks = atom({ plugin: 'fixnote', key: 'checks' } as const, EMPTY_CHECKS, { shape: 'checks-2' })

// ---------- 讀筆記本 ----------

function unquote(value: string): string {
  const v = value.trim()

  return v.length >= 2 && v.startsWith('`') && v.endsWith('`') ? v.slice(1, -1) : v
}

/** 把筆記本的 Markdown 拆成一筆一筆，格式由 fixnote skill 決定 */
export function parseBook(text: string): Entry[] {
  const entries: Entry[] = []

  for (const chunk of text.split(/^## #/m).slice(1)) {
    const head = chunk.split('\n', 1)[0] ?? ''
    const match = /^(\d+)\s+(\S+)\s*[｜|]\s*(.+?)\s*$/.exec(head)
    if (match === null) {
      continue
    }

    const fields: Record<string, string> = {}
    for (const line of chunk.matchAll(/^- \*\*(.+?)\*\*[：:]\s*(.*)$/gm)) {
      fields[line[1] ?? ''] = (line[2] ?? '').trim()
    }

    entries.push({
      no: Number(match[1]),
      date: match[2] ?? '',
      category: match[3] ?? '',
      what: fields['發生什麼事'] ?? '',
      rule: fields['寫死的規定'] ?? '',
      strength: fields['防護強度'] ?? '',
      after: fields['以後會怎樣'] ?? '',
      status: fields['狀態'] ?? '',
      pattern: unquote(fields['擋下規則'] ?? ''),
      exts: unquote(fields['適用檔案'] ?? '')
        .split(/[\s,，]+/)
        .filter(ext => ext !== '')
        .map(ext => (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase()),
      bad: unquote(fields['違規範例'] ?? ''),
      good: unquote(fields['合格範例'] ?? ''),
    })
  }

  return entries
}

export function buildPrompt(what: string): string {
  return `請用 fixnote skill 記一筆糾正筆記。\n發生什麼事：${what.trim()}`
}

/** 規定的第一句，當作防線清單上的短名稱 */
export function shortRule(entry: Entry): string {
  const text = entry.rule || entry.what

  return (text.split(/[，。,;；]/)[0] ?? text).trim()
}

// ---------- 擋下規則 ----------

export function compile(pattern: string): RegExp | null {
  if (pattern === '') {
    return null
  }
  try {
    return new RegExp(pattern, 'm')
  } catch {
    return null
  }
}

export function isLocked(entry: Entry): boolean {
  return compile(entry.pattern) !== null
}

function appliesTo(entry: Entry, path: string): boolean {
  const lower = path.toLowerCase()
  if (/\.(md|markdown|mdx)$/.test(lower)) {
    return false
  }
  const exts = entry.exts.length > 0 ? entry.exts : DEFAULT_EXTS

  return exts.some(ext => lower.endsWith(ext))
}

/** 找出這次寫入違反的第一條規定；沒有就回傳 undefined */
export function findViolation(
  entries: Entry[],
  paused: number[],
  path: string,
  text: string,
): Entry | undefined {
  return entries.find(entry => {
    if (paused.includes(entry.no) || !appliesTo(entry, path)) {
      return false
    }
    const re = compile(entry.pattern)

    return re !== null && re.test(text)
  })
}

export function denyMessage(entry: Entry): string {
  const lines = [
    `糾正筆記 #${entry.no}（${entry.category}）擋下了這次修改。`,
    `規定：${entry.rule || entry.what}`,
  ]
  if (entry.after !== '') {
    lines.push(entry.after)
  }
  if (entry.good !== '') {
    lines.push(`正確寫法的例子：${entry.good}`)
  }
  lines.push('請改用正確寫法修好根本原因。如果這次真的必須這樣寫，先問使用者；使用者可以在糾正筆記面板暫停這條規定。')

  return lines.join('\n')
}

export function runDemo(entry: Entry): Demo {
  const re = compile(entry.pattern)

  return {
    no: entry.no,
    badBlocked: re !== null && entry.bad !== '' && re.test(entry.bad),
    goodBlocked: re !== null && entry.good !== '' && re.test(entry.good),
  }
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

// ---------- 驗證設定 ----------

/** 9 種預設驗證：照片裡選定的那幾種，名稱和一句話說明 */
export const KINDS: { id: CheckKind; code: string; name: string; hint: string }[] = [
  { id: 'lint', code: 'LINT', name: 'lint 規則', hint: '自動掃描程式，抓出禁止的寫法' },
  { id: 'static', code: 'STATIC', name: '靜態分析', hint: '不執行程式就找出問題，含防線掃描' },
  { id: 'unit', code: 'UNIT', name: '單元測試', hint: '測一個小函式的輸入和輸出' },
  { id: 'functional', code: 'FUNC', name: '功能測試', hint: '測一個完整功能有沒有照需求運作' },
  { id: 'regression', code: 'REGRESS', name: '回歸測試', hint: '修好的 bug 不會再回來' },
  { id: 'acceptance', code: 'ACCEPT', name: '驗收測試', hint: '把你的需求寫成測試' },
  { id: 'smoke', code: 'SMOKE', name: '冒煙測試', hint: '程式能不能啟動、載入' },
  { id: 'ui', code: 'UI', name: '畫面測試', hint: '操作畫面，確認看到的東西對' },
  { id: 'mutation', code: 'MUTATE', name: '變異測試', hint: '故意改壞程式，看測試抓不抓得到' },
]

export type CheckSpec = { run: string[]; cwd?: string; match?: string; timeoutMs?: number }
/** 每項驗證最多跑多久；跑比較久的（例如變異測試）可以在 checks.json 用 timeoutMs 調高 */
const DEFAULT_TIMEOUT = 180_000
export type CheckPlan = { scan: string; specs: Partial<Record<CheckKind, CheckSpec>> }

function isKind(id: string): id is CheckKind {
  return KINDS.some(kind => kind.id === id)
}

function toSpec(value: unknown): CheckSpec | null {
  if (value === null || typeof value !== 'object') {
    return null
  }
  const one = value as { run?: unknown; cwd?: unknown; match?: unknown; timeoutMs?: unknown }
  if (!Array.isArray(one.run) || one.run.length === 0) {
    return null
  }

  return {
    run: one.run.filter((part): part is string => typeof part === 'string'),
    ...(typeof one.cwd === 'string' ? { cwd: one.cwd } : {}),
    ...(typeof one.match === 'string' ? { match: one.match } : {}),
    ...(typeof one.timeoutMs === 'number' && one.timeoutMs > 0 ? { timeoutMs: one.timeoutMs } : {}),
  }
}

/** 讀專案的 .fixnote/checks.json；格式不對就回傳 null */
export function parseCheckFile(text: string, cwd: string): CheckPlan | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object') {
    return null
  }
  const obj = raw as { scan?: unknown; checks?: unknown }
  const specs: Partial<Record<CheckKind, CheckSpec>> = {}
  if (obj.checks !== null && typeof obj.checks === 'object' && !Array.isArray(obj.checks)) {
    for (const [id, value] of Object.entries(obj.checks)) {
      const spec = toSpec(value)
      if (isKind(id) && spec !== null) {
        specs[id] = spec
      }
    }
  }

  return { scan: typeof obj.scan === 'string' ? obj.scan : cwd, specs }
}

/** 沒寫在設定檔的驗證：從 package.json 的 scripts 自動偵測 */
export function detectChecks(
  packageJson: string,
  isWindows: boolean,
): Partial<Record<CheckKind, CheckSpec>> {
  let scripts: Record<string, unknown> = {}
  try {
    scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts ?? {}
  } catch {
    return {}
  }
  const npm = (script: string): CheckSpec => ({
    run: isWindows ? ['cmd', '/c', 'npm', 'run', script] : ['npm', 'run', script],
  })
  const candidates: Record<CheckKind, string[]> = {
    lint: ['lint'],
    static: ['typecheck', 'type-check', 'tsc'],
    unit: ['test:unit', 'test'],
    functional: ['test:functional', 'test:integration'],
    regression: ['test:regression'],
    acceptance: ['test:acceptance'],
    smoke: ['test:smoke', 'build'],
    ui: ['test:ui', 'test:e2e', 'e2e'],
    mutation: ['test:mutation', 'mutation', 'stryker'],
  }
  const found: Partial<Record<CheckKind, CheckSpec>> = {}
  for (const kind of KINDS) {
    const script = candidates[kind.id].find(name => typeof scripts[name] === 'string')
    if (script !== undefined) {
      found[kind.id] = npm(script)
    }
  }

  return found
}

/** 把一項驗證的輸出濃縮成一句話；有 match 時只算名稱含那段字的測試 */
export function summarize(
  exitCode: number,
  stdout: string,
  stderr: string,
  match?: string,
): { ok: boolean; detail: string } {
  const all = `${stdout}\n${stderr}`
  const lines = all
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')

  if (match !== undefined) {
    const mine = lines.filter(line => line.includes(match))
    const passed = mine.filter(line => /\(pass\)|✓|√|\bPASS\b/.test(line)).length
    const failed = mine.filter(line => /\(fail\)|✕|×|✗|\bFAIL\b/.test(line))
    if (passed + failed.length === 0) {
      return { ok: false, detail: `找不到名稱含「${match}」的測試` }
    }
    if (failed.length > 0) {
      const name = (failed[0] ?? '')
        .replace(/^\(fail\)\s*/, '')
        .replace(match, '')
        .replace(/\s*\[[\d.]+ms\]$/, '')

      return { ok: false, detail: `${failed.length} 個失敗：${name.slice(0, 40)}` }
    }

    return { ok: true, detail: `${passed} 個通過` }
  }

  const ok = exitCode === 0
  const pass = /(\d+)\s+pass(?:ed|ing)?\b/i.exec(all)
  const fail = /(\d+)\s+fail(?:ed|ing|ures?)?\b/i.exec(all)
  if (pass !== null && fail !== null) {
    return { ok, detail: ok ? `${pass[1]} 個通過` : `${fail[1]} 個失敗` }
  }
  if (ok) {
    return { ok, detail: /warning/i.test(all) ? '通過（有警告）' : '通過' }
  }
  const reason = lines.find(line => /✘|error|fail|錯誤/i.test(line)) ?? lines[lines.length - 1] ?? '失敗'

  return { ok, detail: reason.length > 60 ? `${reason.slice(0, 60)}…` : reason }
}

export function addPrompt(kind: CheckKind): string {
  const info = KINDS.find(one => one.id === kind)

  return [
    `請幫這個專案加上「${info?.name ?? kind}」：${info?.hint ?? ''}。`,
    `做好之後，把執行指令寫進專案的 .fixnote/checks.json 的 checks.${kind}，格式是 { "run": ["指令", "參數"], "cwd": "選填，執行的資料夾", "match": "選填，只算名稱含這段字的測試" }。`,
    '最後用白話告訴我：加了什麼、它會抓到哪種錯。',
  ].join('\n')
}

// ---------- 需要 $ 的動作 ----------

/** 這次載入後看過的已上鎖編號，用來分辨「剛上鎖」的新防線 */
let knownLocked: Set<number> | null = null
let stopAnimation: (() => void) | null = null
let sessionCwd = ''

async function notebookPath($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '~'

  return `${home}/.claude/fixnote/糾正筆記.md`
}

async function loadGuard($: EngineInterface): Promise<Guard> {
  const counts = await $.store.get('counts')
  const paused = await $.store.get('paused')
  const next: Guard = {
    counts: counts !== null && typeof counts === 'object' ? (counts as Record<string, number>) : {},
    paused: Array.isArray(paused) ? paused.filter((n): n is number => typeof n === 'number') : [],
  }
  await update($, guard, () => next)

  return next
}

function celebrate($: EngineInterface, entry: Entry): void {
  stopAnimation?.()
  void update($, flash, () => ({ no: entry.no, frame: 0 }))
  const timer = $.clock.every(260, () => {
    void (async () => {
      const now = await read($, flash)
      if (now === null || now.no !== entry.no) {
        timer.cancel()

        return
      }
      const frame = now.frame + 1
      await update($, flash, () => ({ no: entry.no, frame }))
      if (frame >= LOCK_FRAMES.length - 1) {
        timer.cancel()
        // 上鎖完成，展開這條防線，示範擋下效果
        await update($, demo, () => runDemo(entry))
      }
    })()
  })
  stopAnimation = () => timer.cancel()
  $.ui.toast(`🛡 已上鎖：${shortRule(entry)}`)
}

async function refresh($: EngineInterface): Promise<void> {
  const path = await notebookPath($)
  let next: Book
  try {
    const text = await $.fs.read(path)
    next = { entries: parseBook(text), isMissing: false, error: null }
  } catch (err) {
    const message = String(err)
    next = /ENOENT|no such file|not found|cannot find/i.test(message)
      ? EMPTY_BOOK
      : { entries: [], isMissing: false, error: message }
  }
  await update($, book, () => next)

  const locked = next.entries.filter(isLocked)
  if (knownLocked === null) {
    knownLocked = new Set(locked.map(entry => entry.no))

    return
  }
  const fresh = locked.filter(entry => !knownLocked?.has(entry.no))
  for (const entry of locked) {
    knownLocked.add(entry.no)
  }
  const newest = fresh[fresh.length - 1]
  if (newest !== undefined) {
    celebrate($, newest)
  }
}

async function togglePause($: EngineInterface, no: number): Promise<void> {
  const current = await loadGuard($)
  const paused = current.paused.includes(no)
    ? current.paused.filter(n => n !== no)
    : [...current.paused, no]
  await $.store.set('paused', paused)
  await update($, guard, old => ({ ...old, paused }))
}

async function block($: EngineInterface, entry: Entry, path: string): Promise<void> {
  const current = await loadGuard($)
  const total = (current.counts[String(entry.no)] ?? 0) + 1
  const counts = { ...current.counts, [String(entry.no)]: total }
  await $.store.set('counts', counts)
  await update($, guard, old => ({ ...old, counts }))
  await update($, lastBlock, () => ({ no: entry.no, rule: shortRule(entry), file: baseName(path) }))
  $.ui.toast(`🛡 擋下：${shortRule(entry)}`)
}

async function check($: EngineInterface, path: string, text: string): Promise<Entry | undefined> {
  const b = await read($, book)
  const g = await read($, guard)

  return findViolation(b.entries, g.paused, path, text)
}

async function send($: EngineInterface, value: string): Promise<void> {
  if (value.trim() === '') {
    return
  }
  void $.prompt.submit({ text: buildPrompt(value) })
  await update($, draft, () => '')
  $.ui.toast('已送出，Claude 正在記錄')
}

async function toggleDemo($: EngineInterface, entry: Entry): Promise<void> {
  await update($, demo, now => (now !== null && now.no === entry.no ? null : runDemo(entry)))
}

/** 掃過專案裡現有的程式碼，找出已經違反防線的地方 */
async function scanProject($: EngineInterface, root: string): Promise<{ ok: boolean; detail: string }> {
  const b = await read($, book)
  const g = await read($, guard)
  const rules = b.entries.filter(entry => isLocked(entry) && !g.paused.includes(entry.no))
  if (rules.length === 0) {
    return { ok: true, detail: '還沒有防線可掃' }
  }

  const hits: string[] = []
  let files = 0
  const queue = [root]
  while (queue.length > 0 && files < SCAN_LIMIT) {
    const dir = queue.shift() ?? ''
    let entries: Awaited<ReturnType<EngineInterface['fs']['list']>>
    try {
      entries = await $.fs.list(dir)
    } catch {
      continue
    }
    for (const item of entries) {
      const path = `${dir}/${item.name}`
      if (item.kind === 'dir') {
        if (!SKIP_DIRS.has(item.name)) {
          queue.push(path)
        }
        continue
      }
      if (item.kind !== 'file' || /\.(test|spec)\.[a-z]+$/i.test(item.name) || item.size > 1_000_000) {
        continue
      }
      const candidates = rules.filter(rule => appliesTo(rule, path))
      if (candidates.length === 0) {
        continue
      }
      files += 1
      let text: string
      try {
        text = await $.fs.read(path)
      } catch {
        continue
      }
      for (const rule of candidates) {
        const found = compile(rule.pattern)?.exec(text)
        if (found !== null && found !== undefined) {
          const line = text.slice(0, found.index).split('\n').length
          hits.push(`${item.name}:${line}（#${rule.no}）`)
        }
      }
    }
  }

  return hits.length === 0
    ? { ok: true, detail: `防線掃過 ${files} 個檔案，沒有違規` }
    : { ok: false, detail: `${hits.length} 處違反防線：${hits.slice(0, 2).join('、')}` }
}

async function planChecks($: EngineInterface): Promise<CheckPlan> {
  const cwd = sessionCwd || '.'
  let detected: Partial<Record<CheckKind, CheckSpec>> = {}
  try {
    const isWindows = (await $.env.get('OS')) === 'Windows_NT'
    detected = detectChecks(await $.fs.read(`${cwd}/package.json`), isWindows)
  } catch {
    // 沒有 package.json
  }
  let file: CheckPlan | null = null
  try {
    file = parseCheckFile(await $.fs.read(`${cwd}/.fixnote/checks.json`), cwd)
  } catch {
    // 沒有設定檔
  }

  // 設定檔寫的優先，其餘用自動偵測
  return { scan: file?.scan ?? cwd, specs: { ...detected, ...(file?.specs ?? {}) } }
}

/** 哪幾種驗證已經設定好；靜態分析永遠算有，因為防線掃描一定能跑 */
function configuredOf(plan: CheckPlan): CheckKind[] {
  return KINDS.map(kind => kind.id).filter(id => id === 'static' || plan.specs[id] !== undefined)
}

async function loadPlan($: EngineInterface): Promise<void> {
  const plan = await planChecks($)
  await update($, checks, old => ({ ...old, configured: configuredOf(plan) }))
}

type RunOutcome = Awaited<ReturnType<EngineInterface['process']['run']>> | string

async function runChecks($: EngineInterface): Promise<void> {
  if ((await read($, checks)).isRunning) {
    return
  }
  const plan = await planChecks($)
  const configured = configuredOf(plan)
  await update($, checks, () => ({ isRunning: true, current: null, configured, results: [], ranAt: '' }))

  // 同一個指令只跑一次：例如四種測試共用一次「跑全部測試」，再按名稱分開算
  const cache = new Map<string, RunOutcome>()
  const runOnce = async (spec: CheckSpec): Promise<RunOutcome> => {
    const key = JSON.stringify([spec.run, spec.cwd ?? ''])
    const hit = cache.get(key)
    if (hit !== undefined) {
      return hit
    }
    let ran: RunOutcome
    const limit = spec.timeoutMs ?? DEFAULT_TIMEOUT
    try {
      ran = await $.process.run(spec.run, { cwd: spec.cwd ?? (sessionCwd || undefined), timeoutMs: limit })
    } catch (err) {
      ran = /time/i.test(String(err))
        ? `超過 ${Math.round(limit / 60_000)} 分鐘沒跑完，可在 checks.json 加 timeoutMs 調高`
        : `跑不起來：${String(err).slice(0, 50)}`
    }
    cache.set(key, ran)

    return ran
  }

  const results: CheckResult[] = []
  for (const kind of configured) {
    await update($, checks, old => ({ ...old, current: kind }))
    const start = await $.clock.now()
    const spec = plan.specs[kind]
    let ok = true
    const details: string[] = []

    if (spec !== undefined) {
      const ran = await runOnce(spec)
      if (typeof ran === 'string') {
        ok = false
        details.push(ran)
      } else {
        const summary = summarize(ran.exitCode, ran.stdout, ran.stderr, spec.match)
        ok = summary.ok
        details.push(summary.detail)
      }
    }
    if (kind === 'static') {
      const scan = await scanProject($, plan.scan)
      ok = ok && scan.ok
      details.push(scan.detail)
    }

    results.push({ kind, ok, detail: details.join(' · '), ms: (await $.clock.now()) - start })
    await update($, checks, old => ({ ...old, results: [...results] }))
  }

  const time = new Date(await $.clock.now()).toTimeString().slice(0, 5)
  await update($, checks, () => ({ isRunning: false, current: null, configured, results, ranAt: time }))
  const failed = results.filter(result => !result.ok).length
  $.ui.toast(failed === 0 ? `✓ ${results.length} 項驗證全部通過` : `✕ ${failed} 項驗證沒通過`)
}

function seconds(ms: number): string {
  return ms < 100 ? '' : `${(ms / 1000).toFixed(1)}s`
}

// ---------- hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    sessionCwd = e.cwd
    await $.command.register({ name: 'fixnote-panel', description: '打開糾正筆記面板' })
    await loadGuard($)
    await refresh($)
    await loadPlan($)
    void $.ui.open({ id: PANE, title: TITLE })

    return started
  })

  on('command.run', { command: 'fixnote-panel' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)
    await loadPlan($)

    return { text: '糾正筆記面板已打開。' }
  })

  // 新的一輪開始，上方的「剛擋下」提示就收起來
  on('prompt.submit', async ($, e, next) => {
    await update($, lastBlock, () => null)

    return next(e)
  }).catch((_$, e, next) => next(e))

  // Claude 每做完一輪就重讀筆記本：剛記好的那筆、新上鎖的防線會馬上出現
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($)
    // Claude 可能剛幫專案加上新的驗證
    await loadPlan($)

    return done
  })

  // 防線本身：Claude 寫檔前檢查，違反已上鎖的規定就當場擋下
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const hit = await check($, e.file_path, e.content)
    if (hit === undefined) {
      return next(e)
    }
    await block($, hit, e.file_path)

    return { deny: denyMessage(hit) }
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const hit = await check($, e.file_path, e.new_string)
    if (hit === undefined) {
      return next(e)
    }
    await block($, hit, e.file_path)

    return { deny: denyMessage(hit) }
  }).catch((_$, e, next) => next(e))

  // 輸入框上方：剛擋下一次時，安靜地出現一行
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const last = await read($, lastBlock)
    if (last === null || e.props.hasSurvey) {
      return next(e)
    }
    const { Text } = $.ui.resolve(e)

    return (
      <Text>
        <Text color="green" mono weight="bold">
          ● INTERCEPTED
        </Text>{' '}
        已擋下 {last.rule} <Text dimColor>· {last.file}</Text>
      </Text>
    )
  })

  // 面板：任務控制台的樣子。英文大寫是區塊名稱，旁邊的中文是白話說明
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Input, Text } = table
    // 桌面版、VS Code、手機有 Svg，最上面畫會動的任務顯示幕；終端機沒有，用文字版。
    // 終端機的元素表也查得到 Svg（只是什麼都不畫），所以要看介面種類，不能只看有沒有這個元素
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const value = await read($, draft)
    const b = await read($, book)
    const g = await read($, guard)
    const open = await read($, demo)
    const anim = await read($, flash)
    const c = await read($, checks)

    const latest: Entry | undefined = b.entries[b.entries.length - 1]
    const locked = b.entries.filter(isLocked)
    const active = locked.filter(entry => !g.paused.includes(entry.no))
    const totalBlocks = Object.values(g.counts).reduce((sum, n) => sum + n, 0)
    const guarded = new Set(active.map(entry => entry.category))
    const repeats = new Map<string, number>()
    for (const entry of b.entries) {
      repeats.set(entry.category, (repeats.get(entry.category) ?? 0) + 1)
    }
    const warning = [...repeats].find(([category, n]) => n >= REPEAT && !guarded.has(category))
    const isLocking = anim !== null && anim.frame < LOCK_FRAMES.length - 1

    const passed = c.results.filter(one => one.ok).length
    const failed = c.results.length - passed
    const status =
      failed > 0
        ? { text: '● FAULT', color: 'red' }
        : c.results.length > 0
          ? { text: '● NOMINAL', color: 'green' }
          : { text: '○ STANDBY', color: undefined }

    const pad = (n: number) => String(n).padStart(2, '0')
    const lampOf = (kind: CheckKind): Lamp => {
      if (!c.configured.includes(kind)) {
        return 'off'
      }
      if (c.isRunning && c.current === kind) {
        return 'run'
      }
      const result = c.results.find(one => one.kind === kind)
      if (result === undefined) {
        return 'wait'
      }

      return result.ok ? 'go' : 'fault'
    }
    const mission = missionSvg({
      armed: active.length,
      blocks: totalBlocks,
      checks: KINDS.map(kind => ({ code: kind.code, lamp: lampOf(kind.id) })),
      status: failed > 0 ? 'fault' : c.results.length > 0 ? 'nominal' : 'standby',
      isArming: isLocking,
      ranAt: c.ranAt,
    })
    const missionAlt = `糾正筆記任務顯示幕：${active.length} 條防線生效中，已擋下 ${totalBlocks} 次，驗證 ${passed} 項通過、${failed} 項失敗`
    const tiles = [
      { key: 'tile-guards', value: pad(active.length), unit: 'ARMED', label: 'GUARDS  防線' },
      { key: 'tile-blocks', value: pad(totalBlocks), unit: 'BLOCKED', label: 'INTERCEPTS  擋下' },
      {
        key: 'tile-checks',
        value: c.results.length > 0 ? `${passed}/${c.configured.length}` : '—',
        unit: 'GO',
        label: 'CHECKS  驗證',
      },
    ]

    return (
      <Box flexDirection="column" gap={1}>
        {Svg !== undefined ? (
          <Svg source={mission} alt={missionAlt} />
        ) : (
          <Box flexDirection="column" gap={1}>
            <Box justifyContent="space-between">
              <Text>
                <Text mono weight="bold">
                  FIXNOTE
                </Text>
                <Text mono dimColor>
                  {'  /  MISSION CONTROL'}
                </Text>
              </Text>
              <Text mono weight="bold" color={status.color} dimColor={status.color === undefined}>
                {status.text}
              </Text>
            </Box>

            <Box gap={1}>
              {tiles.map(tile => (
                <Box
                  key={tile.key}
                  flexDirection="column"
                  flexGrow={1}
                  paddingX={1}
                  borderStyle="single"
                  borderDimColor
                >
                  <Text size="title" weight="bold" mono tabular>
                    {tile.value}
                    <Text size="caption" weight="regular" dimColor>
                      {' '}
                      {tile.unit}
                    </Text>
                  </Text>
                  <Text size="caption" mono dimColor>
                    {tile.label}
                  </Text>
                </Box>
              ))}
            </Box>
          </Box>
        )}

        <Box flexDirection="column">
          <Text size="caption" mono dimColor>
            LOG ENTRY  記一筆
          </Text>
          <Input
            key="what"
            placeholder="AI 做錯了什麼？一句話就好"
            value={value}
            submitLabel="LOG 記下"
            autoFocus
            onInput={text => void update($, draft, () => text)}
            onSubmit={text => void send($, text)}
          />
        </Box>

        {b.error !== null && (
          <Text color="red">
            <Text mono weight="bold">
              ● FAULT
            </Text>{' '}
            讀不到筆記本：{b.error}
          </Text>
        )}

        {latest !== undefined && (
          <Box flexDirection="column" paddingX={1} borderStyle="single" borderDimColor>
            <Text size="caption" mono dimColor>
              LATEST  #{pad(latest.no)} · {latest.category}
            </Text>
            {isLocking && anim?.no === latest.no ? (
              <Text color="green" mono weight="bold">
                {LOCK_FRAMES[anim.frame]}
              </Text>
            ) : (
              latest.rule !== '' && (
                <Text>
                  {isLocked(latest) && (
                    <Text color="green" mono weight="bold">
                      {'ARMED  '}
                    </Text>
                  )}
                  {latest.rule}
                </Text>
              )
            )}
            {latest.strength !== '' && (
              <Text size="caption" dimColor>
                <Text mono>STRENGTH</Text>  {latest.strength} — {STRENGTH[latest.strength] ?? ''}
              </Text>
            )}
          </Box>
        )}

        {locked.length > 0 && (
          <Box flexDirection="column">
            <Text size="caption" mono dimColor>
              GUARDS  防線
            </Text>
            {locked.map(entry => {
              const isPaused = g.paused.includes(entry.no)
              const isOpen = open !== null && open.no === entry.no
              const hits = g.counts[String(entry.no)] ?? 0

              return (
                <Box key={`row-${entry.no}`} flexDirection="column">
                  <Button
                    key={`rule-${entry.no}`}
                    plain
                    dimColor={isPaused}
                    onPress={() => void toggleDemo($, entry)}
                  >
                    <Text color={isPaused ? undefined : 'green'} dimColor={isPaused} mono weight="bold">
                      {isPaused ? '○ HOLD ' : '● ARMED'}
                    </Text>{' '}
                    {shortRule(entry)}
                    <Text mono dimColor>
                      {hits > 0 ? `  ×${hits}` : ''}
                    </Text>
                  </Button>
                  {isOpen && (
                    <Box flexDirection="column" paddingLeft={2}>
                      {entry.bad !== '' && (
                        <Text>
                          <Text color={open.badBlocked ? 'green' : 'red'} mono>
                            {open.badBlocked ? 'BLOCK' : 'MISS '}
                          </Text>{' '}
                          <Text mono dimColor>
                            {entry.bad}
                          </Text>
                        </Text>
                      )}
                      {entry.good !== '' && (
                        <Text>
                          <Text color={open.goodBlocked ? 'red' : 'green'} mono>
                            {open.goodBlocked ? 'FALSE' : 'PASS '}
                          </Text>{' '}
                          <Text mono dimColor>
                            {entry.good}
                          </Text>
                        </Text>
                      )}
                      <Text size="caption" dimColor>
                        {open.badBlocked && !open.goodBlocked
                          ? 'VERIFIED · 錯的擋下，對的放行'
                          : 'CHECK RULE · 規則不夠準，按 DEBRIEF 請 Claude 修正'}
                      </Text>
                      <Box>
                        <Button
                          key={`pause-${entry.no}`}
                          plain
                          dimColor
                          label={isPaused ? 'RESUME 恢復' : 'HOLD 暫停'}
                          onPress={() => void togglePause($, entry.no)}
                        />
                      </Box>
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>
        )}

        {warning !== undefined && (
          <Text>
            <Text color="yellow" mono weight="bold">
              ▲ CAUTION
            </Text>{' '}
            {warning[0]} 已出現 {warning[1]} 次，還沒上鎖
          </Text>
        )}

        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text size="caption" mono dimColor>
              PRE-FLIGHT CHECKS  驗證
            </Text>
            <Box gap={2}>
              {c.ranAt !== '' && !c.isRunning && (
                <Text size="caption" mono dimColor>
                  LAST {c.ranAt}
                </Text>
              )}
              {c.isRunning ? (
                <Text size="caption" mono color="yellow">
                  RUNNING · {KINDS.find(kind => kind.id === c.current)?.name ?? '準備中'}
                </Text>
              ) : (
                <Button key="run-checks" plain label="RUN 跑一次" onPress={() => void runChecks($)} />
              )}
            </Box>
          </Box>
          {KINDS.map(kind => {
            const isSet = c.configured.includes(kind.id)
            const result = c.results.find(one => one.kind === kind.id)
            const code = kind.code.padEnd(8)
            if (!isSet) {
              return (
                <Box key={`check-${kind.id}`} gap={1}>
                  <Text dimColor>
                    <Text mono>{`○ OFF   ${code}`}</Text>
                    {kind.name}　{kind.hint}
                  </Text>
                  <Button
                    key={`add-${kind.id}`}
                    plain
                    label="ADD 加上"
                    onPress={() => void $.prompt.submit({ text: addPrompt(kind.id) })}
                  />
                </Box>
              )
            }
            if (result === undefined) {
              const isNow = c.isRunning && c.current === kind.id

              return (
                <Text>
                  <Text mono color={isNow ? 'yellow' : undefined} dimColor={!isNow}>
                    {isNow ? '◌ RUN   ' : '· WAIT  '}
                    {code}
                  </Text>
                  {kind.name}
                  <Text dimColor>{c.isRunning ? '' : '　還沒跑'}</Text>
                </Text>
              )
            }
            const time = seconds(result.ms)

            return (
              <Text>
                <Text mono weight="bold" color={result.ok ? 'green' : 'red'}>
                  {result.ok ? '● GO    ' : '● FAULT '}
                </Text>
                <Text mono dimColor>
                  {code}
                </Text>
                {kind.name}
                <Text dimColor>
                  {'　'}
                  {result.detail}
                  {time === '' ? '' : ` · ${time}`}
                </Text>
              </Text>
            )
          })}
        </Box>

        <Box>
          <Button
            key="review"
            plain
            dimColor
            label="DEBRIEF 回顧"
            onPress={() => void $.prompt.submit({ text: '請用 fixnote skill 回顧糾正筆記。' })}
          />
        </Box>
      </Box>
    )
  })
}

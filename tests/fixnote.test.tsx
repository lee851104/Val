import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  denyMessage,
  detectChecks,
  findViolation,
  parseBook,
  parseCheckFile,
  runDemo,
  shortRule,
  summarize,
} from '../hooks/register'

const BOOK = `# 糾正筆記

## #1 2026-11-20｜功能沒做到

- **發生什麼事**：按儲存沒反應
- **原因**：（推測）沒接上存檔
- **防護方式**：回歸測試
- **寫死的規定**：每次修改後自動確認按儲存後資料還在
- **防護強度**：抓到
- **以後會怎樣**：測試會失敗
- **狀態**：已記錄

## #2 2026-11-20｜繞過問題

- **發生什麼事**：又用 setTimeout 硬等
- **防護方式**：lint 規則
- **寫死的規定**：程式裡不准出現 setTimeout，出現就擋下
- **防護強度**：擋下
- **以後會怎樣**：AI 再寫 setTimeout 會被擋下，要改成等資料載入完成
- **擋下規則**：\`\\bsetTimeout\\s*\\(\`
- **適用檔案**：\`.ts .tsx\`
- **違規範例**：\`setTimeout(() => render(), 500)\`
- **合格範例**：\`await loadData(); render()\`
- **狀態**：已上鎖
`

const PANE = {
  plugin: 'fixnote',
  component: 'Pane',
  requestId: 'fixnote',
  props: {
    title: '糾正筆記',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const PROJECT = 'C:/proj'

/** 桌面版最上面那張任務顯示幕的文字說明（裡面有防線數、擋下次數） */
async function display(ui: { find: (query: { type: string }) => Promise<{ props: Record<string, unknown> } | undefined> }) {
  return String((await ui.find({ type: 'Svg' }))?.props.alt ?? '')
}

/** 底下的引擎：筆記本、專案檔案、家目錄、store、時鐘、指令都從記憶體回答 */
function world(
  on: On,
  options: {
    submitted?: string[]
    book?: () => string
    files?: Record<string, string>
    runs?: string[][]
  } = {},
) {
  const files = options.files ?? {}
  mock.env(on, { USERPROFILE: 'C:/Users/me', OS: 'Windows_NT' })
  mock.store(on)
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 20, 6, 0) })
  const norm = (path: string) => path.replace(/\\/g, '/')
  on('fs.read', (_, e) => {
    const path = norm(e.path)
    if (path.endsWith('糾正筆記.md')) {
      return { value: options.book?.() ?? BOOK }
    }
    const text = files[path]
    if (text === undefined) {
      throw new Error(`ENOENT: ${path}`)
    }

    return { value: text }
  })
  on('fs.list', (_, e) => {
    const dir = norm(e.path ?? PROJECT)
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(files)) {
      if (!path.startsWith(`${dir}/`)) {
        continue
      }
      const rest = path.slice(dir.length + 1).split('/')
      names.set(rest[0] ?? '', rest.length > 1 ? 'dir' : 'file')
    }

    return {
      value: [...names].map(([name, kind]) => ({ name, kind, size: 10, mtimeMs: 0, isLink: false })),
    }
  })
  on('process.run', (_, e) => {
    options.runs?.push([...e.argv])
    const isTest = e.argv.includes('test')

    return {
      value: {
        exitCode: isTest ? 1 : 0,
        stdout: isTest
          ? '(pass) 【單元】a [1ms]\n(pass) 【單元】b [1ms]\n(fail) 【回歸】按 Enter 也能送出 [2ms]\n 2 pass\n 1 fail\n'
          : '✔ Validation passed',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'fixnote-panel' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('prompt.submit', (_, e) => {
    options.submitted?.push(e.text)

    return { text: e.text }
  })

  return clock
}

test('【單元】筆記本解析出擋下規則', async () => {
  const entries = parseBook(BOOK)

  expect(entries.length).toBe(2)
  expect(entries[1]?.pattern).toBe('\\bsetTimeout\\s*\\(')
  expect(entries[1]?.exts).toEqual(['.ts', '.tsx'])
  expect(entries[0]?.pattern).toBe('')
})

test('【單元】只擋適用的檔案，Markdown 與暫停的規則不擋', async () => {
  const entries = parseBook(BOOK)
  const bad = 'setTimeout(() => go(), 500)'

  expect(findViolation(entries, [], 'src/app.ts', bad)?.no).toBe(2)
  expect(findViolation(entries, [], 'src/app.py', bad)).toBeUndefined()
  expect(findViolation(entries, [], 'notes/糾正筆記.md', bad)).toBeUndefined()
  expect(findViolation(entries, [2], 'src/app.ts', bad)).toBeUndefined()
  expect(findViolation(entries, [], 'src/app.ts', 'await load()')).toBeUndefined()
})

test('【驗收】Claude 寫出違規程式碼時被擋下，正確寫法放行', async ($, on) => {
  world(on)
  await $.session.start({ cwd: PROJECT, surface: 'desktop', isInteractive: true })

  const blocked = await $.tool.call({
    tool: 'Edit',
    file_path: 'C:/proj/src/app.ts',
    old_string: 'render()',
    new_string: 'setTimeout(() => render(), 500)',
  })
  expect(blocked.deny).toContain('糾正筆記 #2')

  const allowed = await $.tool.call({
    tool: 'Write',
    file_path: 'C:/proj/src/app.ts',
    content: 'await loadData(); render()',
  })
  expect(allowed.deny).toBeUndefined()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await display(ui)).toContain('已擋下 1 次')
  await ui.unmount()
})

test('【功能】點防線：錯的擋下、對的放行；暫停後不再擋', async ($, on) => {
  world(on)
  await $.session.start({ cwd: PROJECT, surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'rule-2' })
    expect(await ui.find({ type: 'Text', text: /錯的擋下，對的放行/ })).toBeDefined()
    await ui.press({ key: 'rule-2' })
    expect(await ui.find({ type: 'Text', text: /錯的擋下/ })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'rule-2' })
  await ui.press({ key: 'pause-2' })
  await ui.unmount()

  const passed = await $.tool.call({
    tool: 'Write',
    file_path: 'C:/proj/src/app.ts',
    content: 'setTimeout(() => render(), 500)',
  })
  expect(passed.deny).toBeUndefined()
})

test('【回歸】按 Enter 時字還沒存進草稿，也能送出', async ($, on) => {
  const submitted: string[] = []
  world(on, { submitted })
  await $.session.start({ cwd: PROJECT, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'what', text: '   ' })
  expect(submitted.length).toBe(0)

  await ui.input({ key: 'what', text: '它改了我沒叫它改的檔案' })
  expect(submitted[0]).toContain('發生什麼事：它改了我沒叫它改的檔案')
  await ui.unmount()
})

test('【驗收】新規定上鎖：動畫跑完，自動示範擋下效果', async ($, on) => {
  let text = BOOK.split('## #2')[0] ?? ''
  const clock = world(on, { book: () => text })
  await $.session.start({ cwd: PROJECT, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await display(ui)).toContain('0 條防線生效中')

  // Claude 記好第 2 筆（有擋下規則），重讀筆記本
  text = BOOK
  // 測試只關心指令名稱；來源與顯示位置由引擎補上
  await $.command.run({ command: 'fixnote-panel', args: '' } as Parameters<typeof $.command.run>[0])
  expect(await ui.find({ type: 'Text', text: /上鎖中/ })).toBeDefined()

  await clock.advance(260 * 5)
  await clock.settle()
  expect(await display(ui)).toContain('1 條防線生效中')
  expect(await ui.find({ type: 'Text', text: /錯的擋下，對的放行/ })).toBeDefined()
  await ui.unmount()
})

test('【功能】跑驗證：9 種驗證逐項回報，同一個指令只跑一次', async ($, on) => {
  const runs: string[][] = []
  const test = ['claude', 'plugin', 'test', '.']
  world(on, {
    runs,
    files: {
      [`${PROJECT}/.fixnote/checks.json`]: JSON.stringify({
        checks: {
          smoke: { run: ['claude', 'plugin', 'validate', '.'] },
          unit: { run: test, match: '【單元】' },
          regression: { run: test, match: '【回歸】' },
        },
      }),
      [`${PROJECT}/src/app.ts`]: 'const a = 1\nsetTimeout(() => go(), 500)\n',
      [`${PROJECT}/src/ok.ts`]: 'await load()\n',
      [`${PROJECT}/tests/app.test.ts`]: 'setTimeout(() => go(), 1)\n',
      [`${PROJECT}/node_modules/x/index.js`]: 'setTimeout(() => 0)\n',
    },
  })
  await $.session.start({ cwd: PROJECT, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // 還沒跑：設定好的顯示「還沒跑」，沒設定的顯示說明和「加上」
  expect((await ui.find({ type: 'Text', text: /單元測試/ }))?.text).toContain('還沒跑')
  expect(await ui.find({ type: 'Button', key: 'add-mutation' })).toBeDefined()

  await ui.press({ key: 'run-checks' })

  expect((await ui.find({ type: 'Text', text: /靜態分析/ }))?.text).toContain('1 處違反防線：app.ts:2（#2）')
  expect((await ui.find({ type: 'Text', text: /冒煙測試/ }))?.text).toContain('GO')
  expect((await ui.find({ type: 'Text', text: /單元測試/ }))?.text).toContain('2 個通過')
  expect((await ui.find({ type: 'Text', text: /回歸測試/ }))?.text).toContain('1 個失敗：按 Enter 也能送出')
  expect(await ui.find({ type: 'Text', text: /LAST \d\d:\d\d/ })).toBeDefined()
  // 單元和回歸共用同一個測試指令，只跑一次
  expect(runs.length).toBe(2)
  await ui.unmount()
})

test('【功能】按「加上」，請 Claude 幫專案補上那種驗證', async ($, on) => {
  const submitted: string[] = []
  world(on, { submitted })
  await $.session.start({ cwd: PROJECT, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'add-mutation' })
  expect(submitted[0]).toContain('「變異測試」')
  expect(submitted[0]).toContain('checks.mutation')
  await ui.unmount()
})

test('【畫面】四種介面都畫得出面板的主要元素', async ($, on) => {
  world(on)
  await $.session.start({ cwd: PROJECT, surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /01 ARMED/ })).toBeDefined()
    } else {
      const svg = await ui.find({ type: 'Svg' })
      expect(svg?.props.alt).toContain('1 條防線生效中')
      expect(String(svg?.props.source)).toContain('GUARDS ARMED')
    }
    expect(await ui.find({ type: 'Input', key: 'what' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'rule-2' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'run-checks' })).toBeDefined()
    await ui.unmount()
  }
})

test('【單元】沒有設定檔時，從 package.json 偵測驗證', async () => {
  const pkg = JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .', build: 'vite build' } })
  const found = detectChecks(pkg, true)

  expect(Object.keys(found)).toEqual(['lint', 'unit', 'smoke'])
  expect(found.unit?.run).toEqual(['cmd', '/c', 'npm', 'run', 'test'])
  expect(detectChecks(pkg, false).unit?.run).toEqual(['npm', 'run', 'test'])
  expect(parseCheckFile('not json', PROJECT)).toBeNull()
  expect(summarize(0, ' 6 pass\n 0 fail', '').detail).toBe('6 個通過')
  expect(summarize(1, '(pass) 【單元】a\n(fail) 【單元】b [3ms]', '', '【單元】').detail).toBe('1 個失敗：b')
})

// 以下三個測試是變異測試找出來的漏洞：這些地方改壞了，原本的測試抓不到

const PLAIN = `## #3 2026-11-20｜重複的程式碼

- **發生什麼事**：複製貼上同一段
- **擋下規則**：TODO
- **違規範例**：// TODO 之後改用 \`load\`
- **合格範例**：\`\`
`

test('【單元】規定沒寫適用檔案、沒加反引號、沒寫規定時也正確', async () => {
  const [plain] = parseBook(PLAIN)
  const timer = parseBook(BOOK)[1]
  if (plain === undefined || timer === undefined) {
    throw new Error('筆記本解析失敗')
  }

  expect(plain.pattern).toBe('TODO')
  expect(plain.good).toBe('')
  expect(plain.bad).toBe('// TODO 之後改用 `load`')
  expect(findViolation([plain], [], 'src/a.ts', '// TODO')?.no).toBe(3)
  expect(shortRule(plain)).toBe('複製貼上同一段')
  expect(shortRule(timer)).toBe('程式裡不准出現 setTimeout')
  expect(denyMessage(plain).split('\n')).toEqual([
    '糾正筆記 #3（重複的程式碼）擋下了這次修改。',
    '規定：複製貼上同一段',
    '請改用正確寫法修好根本原因。如果這次真的必須這樣寫，先問使用者；使用者可以在糾正筆記面板暫停這條規定。',
  ])
  expect(denyMessage(timer)).toContain('\nAI 再寫 setTimeout 會被擋下')
  expect(denyMessage(timer)).toContain('\n正確寫法的例子：await loadData(); render()')
})

test('【單元】示範只在範例真的符合規則時才算擋下', async () => {
  const timer = parseBook(BOOK)[1]
  if (timer === undefined) {
    throw new Error('筆記本解析失敗')
  }

  expect(runDemo(timer)).toEqual({ no: 2, badBlocked: true, goodBlocked: false })
  expect(runDemo({ ...timer, bad: 'render()' }).badBlocked).toBe(false)
  expect(runDemo({ ...timer, good: 'setTimeout(go)' }).goodBlocked).toBe(true)
})

test('【單元】設定檔格式不對的部分會被略過', async () => {
  const text = JSON.stringify({
    scan: 'D:/other',
    checks: {
      foo: { run: ['a'] },
      unit: null,
      smoke: { run: [] },
      lint: { run: ['eslint'], cwd: 'sub' },
      static: { run: ['tsc'] },
      mutation: { run: ['node', 'mutate.mjs'], timeoutMs: 600000 },
      ui: { run: ['e2e'], timeoutMs: 0 },
      acceptance: { run: ['e2e'], timeoutMs: '5' },
    },
  })
  const plan = parseCheckFile(text, PROJECT)

  expect(plan?.scan).toBe('D:/other')
  expect(Object.keys(plan?.specs ?? {})).toEqual(['lint', 'static', 'mutation', 'ui', 'acceptance'])
  expect(plan?.specs.mutation?.timeoutMs).toBe(600000)
  expect(plan?.specs.ui?.timeoutMs).toBeUndefined()
  expect(plan?.specs.acceptance?.timeoutMs).toBeUndefined()
  expect(plan?.specs.lint).toEqual({ run: ['eslint'], cwd: 'sub' })
  expect(Object.keys(plan?.specs.static ?? {})).toEqual(['run'])
  expect(parseCheckFile('5', PROJECT)).toBeNull()
  expect(parseCheckFile('{"checks": null}', PROJECT)).toEqual({ scan: PROJECT, specs: {} })

  const long = `error ${'x'.repeat(54)}`
  expect(summarize(1, long, '').detail).toBe(long)
  expect(summarize(0, '3 passed', '').detail).toBe('通過')
})

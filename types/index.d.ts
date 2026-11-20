export type Entry = {
  no: number
  date: string
  category: string
  what: string
  rule: string
  strength: string
  after: string
  status: string
  /** 擋下規則：JavaScript 正規表達式的內容，空字串代表這筆沒有上鎖 */
  pattern: string
  /** 適用的副檔名，例如 ['.ts', '.tsx']；空陣列代表用預設清單 */
  exts: string[]
  bad: string
  good: string
}

export type Book = {
  entries: Entry[]
  isMissing: boolean
  error: string | null
}

/** 跨 session 保存在 $.store 的防護資料，這裡是給畫面讀的副本 */
export type Guard = {
  counts: Record<string, number>
  paused: number[]
}

/** 展開中的那條防線，以及它的試擋結果 */
export type Demo = { no: number; badBlocked: boolean; goodBlocked: boolean }

/** 新防線上鎖的動畫：frame 從 0 走到最後一格 */
export type Flash = { no: number; frame: number }

export type LastBlock = { no: number; rule: string; file: string }

/** 9 種預設驗證的代號 */
export type CheckKind =
  | 'lint'
  | 'static'
  | 'unit'
  | 'functional'
  | 'regression'
  | 'acceptance'
  | 'smoke'
  | 'ui'
  | 'mutation'

/** 一項驗證的結果：通過與否、一句話說明、花了多久 */
export type CheckResult = { kind: CheckKind; ok: boolean; detail: string; ms: number }

export type Checks = {
  isRunning: boolean
  /** 正在跑的那一項，跑完是 null */
  current: CheckKind | null
  /** 這個專案已經設定好的驗證 */
  configured: CheckKind[]
  results: CheckResult[]
  /** 上次跑完的時間（HH:MM），還沒跑過是空字串 */
  ranAt: string
}

declare module 'claude-code' {
  interface PluginState {
    fixnote: {
      draft: Shaped<string>
      book: Shaped<Book>
      guard: Shaped<Guard>
      demo: Shaped<Demo | null>
      flash: Shaped<Flash | null>
      lastBlock: Shaped<LastBlock | null>
      checks: Shaped<Checks>
    }
  }
}

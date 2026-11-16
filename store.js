// 本地存储层：纯文件逻辑，不依赖 Cordis / DSH 服务，方便单测。
//
// 目录布局（$DSH_HOME/mail-digest/）：
//   account.json   - IMAP 账号列表（不含密码）、标签清单、自动整理设置
//   messages.json  - 抓到的邮件、标签与一句话摘要
//   threads.json   - 按线程聚合的时间轴与总结
//   reports.json   - 报告索引（正文在 reports/<id>.md）
// 密码按固定键名存在 DSH 凭据库里，所以 account.json 可以直接给人看。
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** 标签 id 进文件名/参数，限制得严一点。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,40}$/

/** 旧版单账号的凭据键；迁移后仍作为第一个账号的回退键。 */
export const SECRET_REF = 'DSH_MAIL_DIGEST_MAIL'

/** 每个账号一个凭据键，避免改一个邮箱把别的一起改掉。 */
export function secretRefFor(accountId) {
  return `DSH_MAIL_DIGEST_MAIL_${String(accountId).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

export const PRIORITIES = ['high', 'normal', 'low']
export const MESSAGE_STATES = ['new', 'filed']

/** 自动整理的最小/最大周期：1 小时 ~ 7 天。 */
export const MIN_INTERVAL_SECONDS = 3600
export const MAX_INTERVAL_SECONDS = 604800
export const DEFAULT_INTERVAL_SECONDS = 21600

/** 标签只是建议起点，模型和用户都可以加新的；不强制归类。 */
export const DEFAULT_TAGS = [
  { id: 'work', name: '工作' },
  { id: 'bill', name: '账单/发票' },
  { id: 'notice', name: '订阅/通知' },
  { id: 'support', name: '客服/售后' },
  { id: 'project', name: '项目协作' },
  { id: 'personal', name: '个人事务' },
]

/**
 * DSH home：显式 $DSH_HOME 优先，与 dsh-home-paths 的约定一致。
 * @returns {string} 绝对路径。
 */
export function dshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return configured.length > 0 ? resolve(configured) : join(homedir(), '.dsh')
}

/** 默认数据目录。 */
export function defaultDir() {
  return join(dshHome(), 'mail-digest')
}

/** 把名字压成 id。 */
export function slugify(name) {
  const ascii = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return ascii.length > 0 ? ascii : `t-${Date.now().toString(36).slice(-6)}`
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback
}

function asNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function asBool(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** 账号 id 进凭据键，限制得严一点。 */
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/

/** 从邮箱地址生成账号 id：邮箱 local part 优先，兜底用主机名。 */
export function accountIdFor(account, takenIds = []) {
  const address = asString(account.user).toLowerCase()
  const local = address.includes('@') ? address.slice(0, address.indexOf('@')) : address
  const base = (slugify(local) || slugify(account.host) || 'mail').slice(0, 32)
  const taken = new Set(takenIds)
  let id = base
  let index = 2
  while (taken.has(id)) {
    id = `${base}-${index}`
    index += 1
  }
  return id
}

/** 校验并补全 IMAP 账号。非法输入抛带字段名的错误，而不是静默丢字段。 */
export function normalizeAccount(input, options = {}) {
  const value = input === null || typeof input !== 'object' || Array.isArray(input) ? {} : input
  const secure = asBool(value.secure, true)
  const port = Math.min(Math.max(1, asNumber(value.port, secure ? 993 : 143)), 65535)
  const rawId = asString(value.id)
  if (rawId !== '' && !ACCOUNT_ID_PATTERN.test(rawId)) {
    throw new Error(`账号 id「${rawId}」不合法：只能用小写字母、数字、- 和 _。`)
  }
  return {
    id: rawId !== '' ? rawId : accountIdFor({ user: value.user, host: value.host }, options.takenIds ?? []),
    name: asString(value.name),
    host: asString(value.host),
    port,
    secure,
    user: asString(value.user),
    mailbox: asString(value.mailbox, 'INBOX') || 'INBOX',
    days: Math.min(Math.max(0, asNumber(value.days, 30)), 3650),
    limit: Math.min(Math.max(1, asNumber(value.limit, 100)), 500),
    fromFilter: asString(value.fromFilter),
    subjectFilter: asString(value.subjectFilter),
    unseenOnly: asBool(value.unseenOnly, false),
  }
}

/**
 * 校验一个标签。name 是给人看的，id 是稳定的短名。
 * @param {unknown} input
 * @param {{ takenIds?: string[] }} options
 */
export function normalizeTag(input, options = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('标签必须是对象。')
  }
  const name = asString(input.name)
  if (name.length === 0) throw new Error('缺少标签名称。')
  if (name.length > 24) throw new Error(`标签名「${name}」太长（最多 24 个字）。`)
  const rawId = asString(input.id)
  const id = rawId.length > 0 ? rawId : slugify(name)
  if (!ID_PATTERN.test(id)) {
    throw new Error(`标签 id「${id}」不合法：只能用小写字母、数字、- 和 _。`)
  }
  const taken = Array.isArray(options.takenIds) ? options.takenIds : []
  if (taken.includes(id) && rawId.length === 0) {
    throw new Error(`已经有 id 为「${id}」的标签；换个名字。`)
  }
  return { id, name }
}

/** 自动整理设置。 */
export function normalizeAuto(input) {
  const value = input === null || typeof input !== 'object' || Array.isArray(input) ? {} : input
  const mode = value.mode === 'daily' ? 'daily' : 'every'
  const rawAt = typeof value.at === 'string' ? value.at.trim() : ''
  const at = /^([01]\d|2[0-3]):[0-5]\d$/.test(rawAt) ? rawAt : '09:00'
  return {
    enabled: asBool(value.enabled, false),
    mode,
    at,
    everySeconds: Math.min(
      Math.max(MIN_INTERVAL_SECONDS, asNumber(value.everySeconds, DEFAULT_INTERVAL_SECONDS)),
      MAX_INTERVAL_SECONDS,
    ),
    scheduleId: asString(value.scheduleId),
    lastRunAt: asString(value.lastRunAt),
    lastError: asString(value.lastError),
    lastReportId: asString(value.lastReportId),
  }
}

/** 邮件指纹：优先 Message-ID，其次发件人+主题+时间。 */
export function messageKey({ messageId, from, subject, date }) {
  const seed = messageId !== undefined && messageId !== null && String(messageId).trim() !== ''
    ? `mid:${messageId}`
    : `raw:${from ?? ''}|${subject ?? ''}|${date ?? ''}`
  return createHash('sha1').update(seed).digest('hex').slice(0, 16)
}

/** 标签列表归一化：去重、截断、去掉空值。 */
export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return []
  const seen = new Set()
  const out = []
  for (const raw of tags) {
    const name = asString(typeof raw === 'string' ? raw : raw?.name)
    if (name === '') continue
    const clipped = name.slice(0, 24)
    const key = clipped.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clipped)
    if (out.length >= 6) break
  }
  return out
}

/** 把一封解析后的邮件压成一条记录。 */
export function normalizeMessage(input, options = {}) {
  const from = asString(input.from)
  const subject = asString(input.subject) || '(无主题)'
  const date = asString(input.date)
  const text = asString(input.text)
  const fingerprint = asString(input.fingerprint) || messageKey({ messageId: input.messageId, from, subject, date })
  return {
    id: asString(input.id) || fingerprint,
    fingerprint,
    accountId: asString(input.accountId),
    messageId: asString(input.messageId),
    inReplyTo: asString(input.inReplyTo),
    references: Array.isArray(input.references) ? input.references.slice(0, 50).map(String) : [],
    threadKey: asString(input.threadKey),
    from,
    fromName: asString(input.fromName),
    to: asString(input.to),
    subject,
    date,
    text: text.length > 20000 ? `${text.slice(0, 20000)}\n…（正文已截断）` : text,
    snippet: text.replace(/\s+/g, ' ').slice(0, 160),
    attachments: Array.isArray(input.attachments) ? input.attachments.slice(0, 20).map(String) : [],
    tags: normalizeTags(options.tags ?? input.tags),
    priority: PRIORITIES.includes(input.priority) ? input.priority : 'normal',
    needsReply: input.needsReply === true,
    summary: asString(input.summary).slice(0, 200),
    status: MESSAGE_STATES.includes(input.status) ? input.status : 'new',
    fetchedAt: asString(input.fetchedAt) || new Date().toISOString(),
  }
}

/** 报告索引项。 */
export function normalizeReport(input) {
  const value = input === null || typeof input !== 'object' ? {} : input
  const id = asString(value.id)
  if (id === '') throw new Error('报告缺 id。')
  return {
    id,
    accountId: asString(value.accountId),
    createdAt: asString(value.createdAt) || new Date().toISOString(),
    title: asString(value.title) || '邮件整理',
    path: asString(value.path),
    htmlPath: asString(value.htmlPath),
    unread: value.unread !== false,
    messages: Math.max(0, asNumber(value.messages, 0)),
    threads: Math.max(0, asNumber(value.threads, 0)),
    summary: asString(value.summary).slice(0, 200),
    auto: value.auto === true,
  }
}

/**
 * 本地文件读写。
 * @param {{ dir?: string }} options - dir 覆盖默认位置（测试用）。
 */
export function createStore(options = {}) {
  const dir = typeof options.dir === 'string' && options.dir.length > 0 ? resolve(options.dir) : defaultDir()
  const paths = {
    account: join(dir, 'account.json'),
    messages: join(dir, 'messages.json'),
    threads: join(dir, 'threads.json'),
    reports: join(dir, 'reports.json'),
    reportsDir: join(dir, 'reports'),
  }

  async function readJson(path, fallback) {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return fallback
      throw error
    }
    if (text.trim() === '') return fallback
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`${path} 不是合法 JSON，先修好这个文件再继续。`)
    }
  }

  /** 原子写：先写临时文件再 rename，避免半截文件。 */
  async function writeJson(path, value) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  }

  async function readState() {
    const parsed = await readJson(paths.account, {})
    const tags = Array.isArray(parsed?.tags)
      ? parsed.tags.filter((item) => item !== null && typeof item === 'object' && typeof item.id === 'string' && typeof item.name === 'string')
      : DEFAULT_TAGS
    // v1 只有一个 account，读的时候顺手迁移成数组，写入时落 v2。
    const raw = Array.isArray(parsed?.accounts)
      ? parsed.accounts
      : (parsed?.account !== undefined && parsed.account !== null ? [parsed.account] : [])
    const taken = []
    const accounts = []
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue
      const account = normalizeAccount(item, { takenIds: taken })
      if (accounts.some((existing) => existing.id === account.id)) continue
      taken.push(account.id)
      accounts.push(account)
    }
    return {
      version: 2,
      accounts,
      tags,
      auto: normalizeAuto(parsed?.auto ?? {}),
    }
  }

  async function writeState(state) {
    const taken = []
    const accounts = []
    for (const item of Array.isArray(state.accounts) ? state.accounts : []) {
      const account = normalizeAccount(item, { takenIds: taken })
      if (accounts.some((existing) => existing.id === account.id)) continue
      taken.push(account.id)
      accounts.push(account)
    }
    const body = {
      version: 2,
      accounts,
      tags: Array.isArray(state.tags) ? state.tags : DEFAULT_TAGS,
      auto: normalizeAuto(state.auto ?? {}),
    }
    await writeJson(paths.account, body)
    return body
  }

  async function readMessages() {
    const parsed = await readJson(paths.messages, {})
    const list = Array.isArray(parsed?.messages) ? parsed.messages : []
    return list.filter((item) => item !== null && typeof item === 'object' && typeof item.id === 'string')
  }

  async function writeMessages(messages) {
    await writeJson(paths.messages, { version: 1, messages })
  }

  async function readThreads() {
    const parsed = await readJson(paths.threads, {})
    return parsed?.threads !== null && typeof parsed?.threads === 'object' && !Array.isArray(parsed.threads)
      ? parsed.threads
      : {}
  }

  async function writeThreads(threads) {
    await writeJson(paths.threads, { version: 1, threads })
  }

  async function readReports() {
    const parsed = await readJson(paths.reports, {})
    const list = Array.isArray(parsed?.reports) ? parsed.reports : []
    return list.filter((item) => item !== null && typeof item === 'object' && typeof item.id === 'string')
  }

  async function writeReports(reports) {
    await writeJson(paths.reports, { version: 1, reports })
  }

  return {
    dir,
    paths,
    readState,
    writeState,
    readMessages,
    writeMessages,
    readThreads,
    writeThreads,
    readReports,
    writeReports,
  }
}

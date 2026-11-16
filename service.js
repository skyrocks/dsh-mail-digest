// Host 服务：账号列表、抓取、线程、报告、自动整理。
//
// 同一层服务两个调用方（见 dsh-doc 的 user-actions 约定）：
//   - 「设置 → 邮件整理」界面通过 ctx.remote.mailDigest.* 调它；
//   - 模型工具 mail_* 也调它。
// 所以「抓一次 / 归一条 / 出一份报告」只实现一次。
//
// 多个邮箱：账号在 state.accounts 里，邮件/线程/报告都带 accountId；界面按账号切换看，
// 自动整理一轮把所有账号都抓一遍、每个账号各出一份报告。
import { execFile } from 'node:child_process'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

import { fetchMessages, verifyAccount } from './imap.js'
import { buildReportContent, localId, renderReportHtml, renderReportMarkdown, reportSummaryText, reportTitle } from './report.js'
import { DIGEST_PROMPT, ensureSchedule, removeSchedule, scheduleService } from './schedule.js'
import {
  SECRET_REF,
  accountIdFor,
  createStore,
  normalizeAccount,
  normalizeMessage,
  normalizeReport,
  normalizeTag,
  normalizeTags,
  PRIORITIES,
  secretRefFor,
  slugify,
} from './store.js'
import { buildThreads, carrySummaries } from './threads.js'

/** 取一个可选服务，拿不到就返回 undefined。 */
function optionalService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

function pick(value, allowed, field) {
  if (value === undefined || value === null || value === '') return null
  const text = String(value).trim()
  if (!allowed.includes(text)) {
    throw new Error(`${field} 只能是 ${allowed.join(' / ')}（收到「${text}」）。`)
  }
  return text
}

/** 邮件列表给界面/工具看的形态：不带正文，正文单独取。 */
function summaryOf(message) {
  return {
    id: message.id,
    accountId: message.accountId ?? '',
    from: message.from,
    fromName: message.fromName,
    subject: message.subject,
    date: message.date,
    snippet: message.snippet,
    tags: Array.isArray(message.tags) ? message.tags : [],
    priority: message.priority ?? 'normal',
    needsReply: message.needsReply === true,
    summary: message.summary ?? '',
    status: message.status ?? 'new',
    threadKey: message.threadKey ?? '',
    attachments: Array.isArray(message.attachments) ? message.attachments : [],
  }
}

/** 账号给界面/工具看的形态：带上 hasPassword 与各自的计数。 */
function accountOf(account, { hasPassword, messages, threads, reports }) {
  const mine = messages.filter((message) => message.accountId === account.id)
  const myThreads = Object.values(threads).filter((thread) => (thread.accountId ?? '') === account.id)
  const myReports = reports.filter((report) => (report.accountId ?? '') === account.id)
  return {
    ...account,
    hasPassword,
    configured: account.host !== '' && account.user !== '',
    counts: {
      messages: mine.length,
      unfiled: mine.filter((message) => (message.status ?? 'new') === 'new').length,
      threads: myThreads.length,
      reports: myReports.length,
      unreadReports: myReports.filter((report) => report.unread === true).length,
    },
  }
}

function clipText(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…（正文已截断，全文 ${value.length} 字）`
}

export class MailDigestService extends TypertRemoteService {
  constructor(ctx, options = {}) {
    super(ctx, 'mailDigest')
    this.store = createStore(typeof options.dir === 'string' ? { dir: options.dir } : {})
    this.running = false
  }

  /** 一个账号的密码：先查它自己的凭据键，再退到旧版单账号键，最后看环境变量。 */
  async secretFor(account) {
    const refs = account === undefined
      ? [SECRET_REF]
      : [secretRefFor(account.id), SECRET_REF]
    const credentials = optionalService(this.ctx, 'credentials')
    if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
      for (const ref of refs) {
        try {
          const found = await credentials.resolve(ref)
          if (found !== undefined && found !== null && typeof found.value === 'string' && found.value !== '') {
            return found.value
          }
        } catch {
          // 未设置或凭据服务拒绝，继续看下一个
        }
      }
    }
    for (const ref of refs) {
      const value = process.env[ref] ?? ''
      if (value !== '') return value
    }
    return ''
  }

  async hasSecret(account) {
    const credentials = optionalService(this.ctx, 'credentials')
    if (credentials !== undefined && credentials !== null && typeof credentials.describe === 'function') {
      for (const ref of [secretRefFor(account.id), SECRET_REF]) {
        try {
          if ((await credentials.describe(ref))?.configured === true) return true
        } catch {
          // 忽略，继续看下一条
        }
      }
    }
    return (process.env[secretRefFor(account.id)] ?? '') !== '' || (process.env[SECRET_REF] ?? '') !== ''
  }

  /** 状态：账号列表（各自计数）、标签、自动设置。 */
  async status() {
    const state = await this.store.readState()
    const messages = await this.store.readMessages()
    const reports = await this.store.readReports()
    const threads = await this.store.readThreads()

    const accounts = []
    for (const account of state.accounts) {
      accounts.push(accountOf(account, {
        hasPassword: await this.hasSecret(account),
        messages,
        threads,
        reports,
      }))
    }

    return {
      accounts,
      tags: state.tags,
      auto: state.auto,
      counts: {
        accounts: accounts.length,
        messages: messages.length,
        unfiled: messages.filter((message) => (message.status ?? 'new') === 'new').length,
        threads: Object.keys(threads).length,
        reports: reports.length,
        unreadReports: reports.filter((report) => report.unread === true).length,
      },
      dir: this.store.dir,
      running: this.running,
    }
  }

  /**
   * 新增或更新一个账号（按 id 判断），可选同时改标签清单。
   * @param {{ account?: object, password?: string, tags?: object[] }} request
   */
  async save(request) {
    const current = await this.store.readState()
    const input = request?.account
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('save: 缺少 account。')
    }

    const rawId = String(input.id ?? '').trim()
    const others = current.accounts.filter((account) => account.id !== rawId)
    const account = normalizeAccount(
      { ...input, id: rawId },
      { takenIds: others.map((item) => item.id) },
    )
    if (account.host === '' || account.user === '') {
      throw new Error('服务器和账号都要填。')
    }
    if (!account.name) account.name = account.user

    const nextAccounts = rawId !== '' && current.accounts.some((item) => item.id === account.id)
      ? current.accounts.map((item) => (item.id === account.id ? account : item))
      : [...current.accounts, account]

    let tags = current.tags
    if (Array.isArray(request?.tags)) tags = allocateTags(current.tags, request.tags)

    const password = typeof request?.password === 'string' ? request.password : undefined
    if (password !== undefined && password !== '') {
      const credentials = optionalService(this.ctx, 'credentials')
      if (credentials === undefined || credentials === null || typeof credentials.set !== 'function') {
        throw new Error('这个 DSH 部署没有可写的凭据库，密码存不下来；先配置 credentials 再保存。')
      }
      await credentials.set(secretRefFor(account.id), password)
    }

    const state = { ...current, accounts: nextAccounts, tags }

    // 第一次建账号时，把旧版（单账号时代）留下的孤儿邮件认领过来。
    if (rawId === '' && current.accounts.length === 0) {
      const adopted = await this.adoptOrphans(account.id)
      if (adopted > 0) state.auto = { ...state.auto }
    }

    await this.store.writeState(state)
    return this.status()
  }

  /**
   * 删掉一个账号。deleteData=true 时连它的邮件、线程、报告一起删。
   * @param {{ id?: string, deleteData?: boolean }} request
   */
  async removeAccount(request) {
    const id = String(request?.id ?? '').trim()
    if (id === '') throw new Error('removeAccount: 缺少 id。')
    const current = await this.store.readState()
    if (!current.accounts.some((account) => account.id === id)) {
      return { removed: false, messages: 0, reports: 0 }
    }

    await this.store.writeState({ ...current, accounts: current.accounts.filter((account) => account.id !== id) })

    const credentials = optionalService(this.ctx, 'credentials')
    if (credentials !== undefined && credentials !== null && typeof credentials.unset === 'function') {
      try {
        await credentials.unset(secretRefFor(id))
      } catch {
        // 凭据删不掉不影响账号已经移除
      }
    }

    let deletedMessages = 0
    let deletedReports = 0
    if (request?.deleteData === true) {
      const messages = await this.store.readMessages()
      const kept = messages.filter((message) => message.accountId !== id)
      deletedMessages = messages.length - kept.length
      await this.store.writeMessages(kept)

      const threads = await this.store.readThreads()
      const keptThreads = Object.fromEntries(Object.entries(threads).filter(([, thread]) => (thread.accountId ?? '') !== id))
      await this.store.writeThreads(keptThreads)

      const reports = await this.store.readReports()
      const mine = reports.filter((report) => (report.accountId ?? '') === id)
      deletedReports = mine.length
      for (const report of mine) {
        if (report.path === '') continue
        try {
          await unlink(report.path)
        } catch {
          // 文件可能已经被手动删了
        }
      }
      await this.store.writeReports(reports.filter((report) => (report.accountId ?? '') !== id))
    }

    return { removed: true, messages: deletedMessages, reports: deletedReports }
  }

  /** 把 accountId 为空的旧邮件认领给第一个账号（并补上带前缀的 id）。 */
  async adoptOrphans(accountId) {
    const messages = await this.store.readMessages()
    const orphans = messages.filter((message) => (message.accountId ?? '') === '')
    if (orphans.length === 0) return 0
    const taken = new Set(messages.map((message) => message.id))
    for (const message of orphans) {
      const next = `${accountId}:${message.messageId !== '' ? message.messageId : message.id}`
      message.accountId = accountId
      if (!taken.has(next)) {
        taken.delete(message.id)
        message.id = next
        taken.add(next)
      }
    }
    const threads = await this.store.readThreads()
    const rebuilt = buildThreads(messages)
    for (const message of messages) message.threadKey = rebuilt.byMessage.get(message.id) ?? ''
    const merged = carrySummaries(threads, rebuilt.threads)
    await this.store.writeMessages(messages)
    await this.store.writeThreads(Object.fromEntries(merged.map((thread) => [thread.key, thread])))
    return orphans.length
  }

  /** 用表单里的值试连一次（不落盘）；没给 id 时用旧版凭据兜底。 */
  async probe(request) {
    const input = request?.account
    const account = normalizeAccount(input ?? {}, {})
    if (account.host === '' || account.user === '') {
      return { ok: false, elapsedMs: 0, error: '先选服务商并填账号。' }
    }
    const typed = typeof request?.password === 'string' && request.password !== '' ? request.password : undefined
    const password = typed ?? (await this.secretFor(account))
    if (password === '') return { ok: false, elapsedMs: 0, error: '还没有密码（或授权码）。填上再试。' }
    return verifyAccount(account, password)
  }

  /**
   * 抓一次。给了 accountId 就只抓那个账号，否则把所有配好的账号都抓一遍。
   * @param {{ accountId?: string, limit?: number }} request
   */
  async fetch(request) {
    if (this.running) return { added: 0, accounts: [], threads: [], note: '上一次抓取还没结束。' }
    const state = await this.store.readState()
    const wantedId = typeof request?.accountId === 'string' ? request.accountId : ''
    const wanted = wantedId !== ''
      ? state.accounts.filter((account) => account.id === wantedId)
      : state.accounts
    if (wanted.length === 0) {
      throw new Error(wantedId === ''
        ? '还没有邮箱，先到「配置」添加。'
        : `没有这个邮箱（看看「配置」里的列表）。`)
    }

    this.running = true
    try {
      const results = []
      const incoming = []
      const existing = await this.store.readMessages()
      const known = new Set(existing.map((message) => `${message.accountId ?? ''}|${message.fingerprint ?? message.id}`))

      for (const account of wanted) {
        if (account.host === '' || account.user === '') {
          results.push({ id: account.id, name: account.name || account.user, added: 0, error: '账号没填完整' })
          continue
        }
        const password = await this.secretFor(account)
        if (password === '') {
          results.push({ id: account.id, name: account.name || account.user, added: 0, error: '还没有密码（授权码）' })
          continue
        }
        const limit = typeof request?.limit === 'number' && Number.isFinite(request.limit)
          ? Math.min(Math.max(1, request.limit), 500)
          : account.limit
        try {
          const result = await fetchMessages({ ...account, limit }, password, { knownKeys: known, limit })
          let added = 0
          for (const raw of result.messages) {
            const fingerprint = raw.id
            const key = `${account.id}|${fingerprint}`
            if (known.has(key)) continue
            known.add(key)
            incoming.push(normalizeMessage({ ...raw, accountId: account.id, fingerprint, id: `${account.id}:${fingerprint}` }))
            added += 1
          }
          results.push({
            id: account.id,
            name: account.name || account.user,
            added,
            skipped: result.skipped,
            scanned: result.scanned,
          })
        } catch (error) {
          results.push({
            id: account.id,
            name: account.name || account.user,
            added: 0,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      const all = [...incoming, ...existing].sort((a, b) => String(b.date).localeCompare(String(a.date)))
      const threads = await this.reindexWith(all)
      const addedIds = new Set(incoming.map((message) => message.id))
      const fresh = threads.filter((thread) => (thread.messageIds ?? []).some((id) => addedIds.has(id)))

      const added = incoming.length
      const failed = results.filter((item) => item.error !== undefined)
      const lines = results.map((item) => (
        item.error === undefined
          ? `- ${item.name}：新增 ${item.added} 封（扫描 ${item.scanned ?? 0} 封）`
          : `- ${item.name}：失败——${item.error}`
      ))

      return {
        added,
        accounts: results,
        threads: fresh.map((thread) => ({
          key: thread.key,
          accountId: thread.accountId ?? '',
          subject: thread.subject,
          count: thread.count,
          firstAt: thread.firstAt,
          lastAt: thread.lastAt,
          needsSummary: (thread.summaryCount ?? 0) < thread.count,
        })),
        total: all.length,
        note: added === 0 && failed.length === 0
          ? `没有新邮件（库里共 ${existing.length} 封）。`
          : `新增 ${added} 封（库里共 ${all.length} 封，涉及 ${fresh.length} 条线程）${failed.length > 0 ? `；${failed.length} 个账号失败` : ''}：\n${lines.join('\n')}`,
      }
    } finally {
      this.running = false
    }
  }

  /**
   * 重算线程并把 threadKey 写回邮件（旧总结按 key / 主题+联系人接续）。
   * @param {object[]} messages - 已经按时间倒序的邮件
   */
  async reindexWith(messages) {
    const previousThreads = await this.store.readThreads()
    const built = buildThreads(messages)
    for (const message of messages) {
      message.threadKey = built.byMessage.get(message.id) ?? ''
    }
    // 只保留还在库里的线程，删账号/删邮件后不会留下幽灵线程。
    const live = new Set(built.threads.map((thread) => thread.key))
    const previous = Object.fromEntries(Object.entries(previousThreads).filter(([key]) => live.has(key)))
    const withSummaries = carrySummaries(previous, built.threads)
    await this.store.writeMessages(messages)
    await this.store.writeThreads(Object.fromEntries(withSummaries.map((thread) => [thread.key, thread])))
    return withSummaries
  }

  /** 按库里的邮件重建线程（测试和排障用）。 */
  async reindex() {
    const messages = await this.store.readMessages()
    const threads = await this.reindexWith(messages)
    return { threads: threads.length, messages: messages.length }
  }

  /**
   * 列表。accountId 为空时列全部账号。
   * @param {{ accountId?: string, status?: string, tag?: string, limit?: number, since?: string }} request
   */
  async list(request) {
    const messages = await this.store.readMessages()
    const accountId = typeof request?.accountId === 'string' && request.accountId !== '' ? request.accountId : null
    const status = typeof request?.status === 'string' && request.status !== '' ? request.status : null
    const tag = typeof request?.tag === 'string' && request.tag !== '' ? request.tag : null
    const since = typeof request?.since === 'string' && request.since !== '' ? request.since : null
    const limit = typeof request?.limit === 'number' && Number.isFinite(request.limit)
      ? Math.min(Math.max(1, request.limit), 1000)
      : 200

    const scoped = accountId === null ? messages : messages.filter((message) => (message.accountId ?? '') === accountId)
    const filtered = scoped.filter((message) => (
      (status === null || (message.status ?? 'new') === status)
      && (tag === null || (message.tags ?? []).includes(tag))
      && (since === null || String(message.date) >= since)
    ))

    const tagCounts = {}
    for (const message of scoped) {
      for (const name of message.tags ?? []) tagCounts[name] = (tagCounts[name] ?? 0) + 1
    }

    return {
      messages: filtered.slice(0, limit).map(summaryOf),
      total: filtered.length,
      counts: {
        messages: scoped.length,
        unfiled: scoped.filter((message) => (message.status ?? 'new') === 'new').length,
      },
      tagCounts,
    }
  }

  /** 一封邮件的全文。 */
  async read(request) {
    const id = typeof request?.id === 'string' ? request.id : ''
    if (id === '') throw new Error('缺少邮件 id。')
    const messages = await this.store.readMessages()
    const found = messages.find((message) => message.id === id)
    if (found === undefined) throw new Error(`没有 id 为「${id}」的邮件（可能已被清掉）。`)
    const threads = await this.store.readThreads()
    const thread = found.threadKey !== '' ? threads[found.threadKey] : undefined
    return {
      message: { ...summaryOf(found), text: found.text ?? '' },
      thread: thread === undefined ? null : { key: thread.key, subject: thread.subject, count: thread.count, summary: thread.summary ?? '' },
    }
  }

  /** 读整条线程（时间轴）：给模型写总结用，按时间正序、正文截断。 */
  async thread(request) {
    let key = typeof request?.key === 'string' ? request.key : ''
    const id = typeof request?.id === 'string' ? request.id : ''
    const messages = await this.store.readMessages()
    if (key === '' && id !== '') {
      const hit = messages.find((message) => message.id === id)
      if (hit === undefined) throw new Error(`没有 id 为「${id}」的邮件。`)
      key = hit.threadKey ?? ''
    }
    if (key === '') throw new Error('缺少线程 key（可以先调 mail_inbox，用返回里的 threadKey）。')
    const threads = await this.store.readThreads()
    const thread = threads[key]
    if (thread === undefined) throw new Error(`没有 key 为「${key}」的线程（可能还没抓过这封邮件）。`)

    const list = messages
      .filter((message) => message.threadKey === key)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map((message) => ({
        id: message.id,
        date: message.date,
        from: message.from,
        fromName: message.fromName,
        subject: message.subject,
        summary: message.summary ?? '',
        tags: message.tags ?? [],
        text: clipText(message.text, 3000),
      }))

    return {
      thread: {
        key: thread.key,
        accountId: thread.accountId ?? '',
        subject: thread.subject,
        participants: thread.participants ?? [],
        count: thread.count,
        firstAt: thread.firstAt,
        lastAt: thread.lastAt,
        summary: thread.summary ?? '',
        summarizedAt: thread.summarizedAt ?? '',
      },
      messages: list,
      needsSummary: (thread.summaryCount ?? 0) < (thread.count ?? list.length),
    }
  }

  /** 写回整理结果：标签、优先级、是否要回复、一句话摘要、状态。 */
  async file(request) {
    const items = Array.isArray(request?.items) ? request.items : []
    if (items.length === 0) throw new Error('没有要写入的整理结果。')
    const messages = await this.store.readMessages()
    const byId = new Map(messages.map((message) => [message.id, message]))
    const updated = []

    for (const item of items) {
      const id = typeof item?.id === 'string' ? item.id : ''
      if (id === '') throw new Error('每一项都要带邮件 id。')
      const target = byId.get(id)
      if (target === undefined) throw new Error(`没有 id 为「${id}」的邮件。`)

      if (item.tags !== undefined) target.tags = normalizeTags(item.tags)
      if (item.priority !== undefined) target.priority = pick(item.priority, PRIORITIES, 'priority') ?? 'normal'
      if (item.needsReply !== undefined) target.needsReply = item.needsReply === true
      if (item.summary !== undefined) target.summary = String(item.summary ?? '').trim().slice(0, 200)
      if (item.status !== undefined) target.status = pick(item.status, ['new', 'filed'], 'status') ?? 'new'
      if (item.status === undefined) target.status = 'filed'
      target.filedAt = new Date().toISOString()
      updated.push(summaryOf(target))
    }

    await this.store.writeMessages(messages)
    return { messages: updated, total: updated.length }
  }

  /** 写一条线程的时间轴总结。 */
  async summarize(request) {
    const key = typeof request?.key === 'string' ? request.key : ''
    const summary = typeof request?.summary === 'string' ? request.summary.trim() : ''
    if (key === '') throw new Error('缺少线程 key。')
    if (summary === '') throw new Error('总结不能为空；写不出来就写「这条线目前只是通知，没有需要行动的内容」。')
    const threads = await this.store.readThreads()
    const thread = threads[key]
    if (thread === undefined) throw new Error(`没有 key 为「${key}」的线程。`)
    thread.summary = summary.slice(0, 4000)
    thread.summarizedAt = new Date().toISOString()
    thread.summaryCount = thread.count ?? 0
    await this.store.writeThreads(threads)
    return {
      thread: {
        key: thread.key,
        subject: thread.subject,
        count: thread.count,
        summary: thread.summary,
        summarizedAt: thread.summarizedAt,
      },
    }
  }

  /**
   * 生成一个账号的报告：只保留「重点 / 需要处理 / 线程进展」，不逐封罗列。
   * 同时写 .md、.html 和 .json（面板用），并把报告登记成未读。
   * @param {{ accountId?: string, title?: string, overview?: string, focus?: object[], auto?: boolean }} request
   */
  async report(request) {
    const state = await this.store.readState()
    const accountId = typeof request?.accountId === 'string' ? request.accountId : ''
    if (accountId === '') throw new Error('report: 需要 accountId（先调 mail_status 看账号列表）。')
    const account = state.accounts.find((item) => item.id === accountId)
    if (account === undefined) throw new Error(`没有 id 为「${accountId}」的账号。`)

    const messages = await this.store.readMessages()
    const threads = await this.store.readThreads()
    const reports = await this.store.readReports()

    const pending = messages.filter((message) => (
      (message.accountId ?? '') === accountId
      && (message.status ?? 'new') === 'filed'
      && (typeof message.reportedAt !== 'string' || message.reportedAt === '')
    ))

    if (pending.length === 0) {
      return {
        id: '',
        path: '',
        htmlPath: '',
        markdown: '',
        empty: true,
        stats: { newMessages: 0, newThreads: 0, activeThreads: 0, needReply: 0, high: 0 },
        note: `${account.name || account.user}：没有新的整理结果。`,
      }
    }

    const now = new Date()
    const keys = [...new Set(pending.map((message) => message.threadKey).filter((key) => key !== ''))]
    const activeThreads = keys.map((key) => threads[key]).filter((thread) => thread !== undefined)
    const pendingIds = new Set(pending.map((message) => message.id))

    const threadMessages = new Map()
    for (const key of keys) {
      const list = messages
        .filter((message) => message.threadKey === key)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .map((message) => ({ ...message, __isNew: pendingIds.has(message.id) }))
      threadMessages.set(key, list)
    }

    const stats = {
      newMessages: pending.length,
      newThreads: activeThreads.filter((thread) => {
        const list = threadMessages.get(thread.key) ?? []
        return list.length > 0 && list.every((message) => message.__isNew === true)
      }).length,
      activeThreads: activeThreads.length,
      needReply: pending.filter((message) => message.needsReply === true).length,
      high: pending.filter((message) => message.priority === 'high').length,
    }

    const id = uniqueReportId(`r-${localId(now)}`, reports.map((report) => report.id))
    const content = buildReportContent({
      id,
      accountId,
      createdAt: now.toISOString(),
      account,
      messages: pending,
      threads: activeThreads,
      threadMessages,
      stats,
      overview: request?.overview,
      focus: request?.focus,
      ignored: 0,
    })

    const markdown = renderReportMarkdown(content)
    const html = renderReportHtml(content)
    const dir = join(this.store.dir, 'reports')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, `${id}.md`)
    const htmlPath = join(dir, `${id}.html`)
    const jsonPath = join(dir, `${id}.json`)
    await writeFile(path, markdown, { encoding: 'utf8', mode: 0o600 })
    await writeFile(htmlPath, html, { encoding: 'utf8', mode: 0o600 })
    await writeFile(jsonPath, `${JSON.stringify(content, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })

    const title = typeof request?.title === 'string' && request.title.trim() !== '' ? request.title.trim() : content.title
    const record = normalizeReport({
      id,
      accountId,
      createdAt: now.toISOString(),
      title,
      path,
      htmlPath,
      unread: true,
      messages: stats.newMessages,
      threads: stats.activeThreads,
      summary: reportSummaryText(content),
      auto: request?.auto === true,
    })
    await this.store.writeReports([record, ...reports])

    const stamp = now.toISOString()
    for (const message of pending) message.reportedAt = stamp
    await this.store.writeMessages(messages)

    await this.store.writeState({
      ...state,
      auto: { ...state.auto, lastRunAt: stamp, lastReportId: id, lastError: '' },
    })

    return {
      id,
      path,
      htmlPath,
      markdown,
      empty: false,
      stats,
      title,
      note: `${account.name || account.user}：报告已生成（${title}）`,
    }
  }

  /** 读一份报告的结构化内容（侧边栏面板渲染用）；旧报告只有 md 时退回原文。 */
  async reportContent(request) {
    const id = typeof request?.id === 'string' ? request.id : ''
    if (id === '') throw new Error('reportContent: 缺少 id。')
    const dir = join(this.store.dir, 'reports')
    try {
      const content = JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8'))
      let html = ''
      try {
        html = await readFile(join(dir, `${id}.html`), 'utf8')
      } catch {
        // 没有网页版就只给结构化内容
      }
      return { content, html }
    } catch {
      // 0.3.x 之前的报告只有 Markdown：原样给面板，至少能看。
      try {
        const markdown = await readFile(join(dir, `${id}.md`), 'utf8')
        const reports = await this.store.readReports()
        const report = reports.find((item) => item.id === id)
        let html = ''
        try {
          html = await readFile(join(dir, `${id}.html`), 'utf8')
        } catch {
          // 旧报告可能没有网页版
        }
        return {
          content: {
            id,
            title: report?.title ?? `报告 ${id}`,
            overview: '',
            focus: [],
            stats: {},
            tags: [],
            pending: [],
            threads: [],
            rest: [],
            raw: markdown
          }
        }
      } catch (error) {
        throw new Error(`报告内容读不出来：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /** 用系统默认程序打开报告的网页版（macOS 就是默认浏览器）。 */
  async openInBrowser(request) {
    const id = typeof request?.id === 'string' ? request.id : ''
    if (id === '') throw new Error('openInBrowser: 缺少 id。')
    const reports = await this.store.readReports()
    const report = reports.find((item) => item.id === id)
    if (report === undefined) throw new Error(`没有 id 为「${id}」的报告。`)
    const target = report.htmlPath !== '' ? report.htmlPath : report.path
    if (target === '') throw new Error('这份报告没有可打开的文件。')
    const command = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'explorer' : 'xdg-open')
    await new Promise((resolve, reject) => {
      execFile(command, [target], (error) => (error === null ? resolve() : reject(error)))
    })
    return { ok: true, path: target }
  }

  /** 报告的列表 / 未读 / 查看 / 删除；accountId 可选，用于只看某个邮箱。 */
  async reports(request) {
    const action = typeof request?.action === 'string' && request.action !== '' ? request.action : 'list'
    const accountId = typeof request?.accountId === 'string' && request.accountId !== '' ? request.accountId : null
    const all = await this.store.readReports()
    const reports = accountId === null ? all : all.filter((report) => (report.accountId ?? '') === accountId)

    if (action === 'list') {
      const limit = typeof request?.limit === 'number' && Number.isFinite(request.limit)
        ? Math.min(Math.max(1, request.limit), 200)
        : 50
      return {
        reports: reports.slice(0, limit).map((report) => ({
          id: report.id,
          accountId: report.accountId ?? '',
          createdAt: report.createdAt,
          title: report.title,
          unread: report.unread === true,
          messages: report.messages ?? 0,
          threads: report.threads ?? 0,
          summary: report.summary ?? '',
          auto: report.auto === true,
        })),
        unread: reports.filter((report) => report.unread === true).length,
        total: reports.length,
      }
    }

    if (action === 'unread') {
      const unread = reports.filter((report) => report.unread === true)
      return {
        unread: unread.length,
        latest: unread.length === 0 ? null : {
          id: unread[0].id,
          accountId: unread[0].accountId ?? '',
          createdAt: unread[0].createdAt,
          title: unread[0].title,
          summary: unread[0].summary ?? '',
        },
        items: unread.slice(0, 20).map((report) => ({
          id: report.id,
          accountId: report.accountId ?? '',
          createdAt: report.createdAt,
          title: report.title,
          summary: report.summary ?? '',
        })),
      }
    }

    if (action !== 'read' && action !== 'delete') {
      throw new Error(`reports: 不认识的 action「${action}」（list / unread / read / delete）。`)
    }
    const id = typeof request?.id === 'string' ? request.id : ''
    if (id === '') throw new Error(`reports: ${action} 需要 id。`)
    const index = all.findIndex((report) => report.id === id)
    if (index < 0) throw new Error(`没有 id 为「${id}」的报告。`)

    if (action === 'read') {
      const report = all[index]
      let markdown = ''
      try {
        markdown = await readReportFile(report.path)
      } catch (error) {
        markdown = `# ${report.title}\n\n报告文件读不出来：${error instanceof Error ? error.message : String(error)}\n`
      }
      all[index] = { ...report, unread: false }
      await this.store.writeReports(all)
      return { report: { ...all[index] }, markdown }
    }

    const [removed] = all.splice(index, 1)
    await this.store.writeReports(all)
    // 三种产物都删掉（md / html / json），别在磁盘上留能读到的残件。
    const files = new Set([removed.path, removed.htmlPath, join(this.store.dir, 'reports', `${removed.id}.json`)])
    for (const file of files) {
      if (typeof file !== 'string' || file === '') continue
      try {
        await unlink(file)
      } catch {
        // 文件可能被手动删了，索引清掉就算成功
      }
    }
    // 把这一批邮件退回「待报告」：下次整理会重新把它们收进新报告，
    // 标签、摘要、线程总结都还在，不用重新打。批次就是同一个时间戳。
    const messages = await this.store.readMessages()
    let restored = 0
    for (const message of messages) {
      if (message.reportedAt === removed.createdAt) {
        delete message.reportedAt
        restored += 1
      }
    }
    if (restored > 0) await this.store.writeMessages(messages)

    return { removed: true, id, restored }
  }

  /**
   * 手动跑一次：借计划任务在几秒后投递一轮整理（复用自动整理已经建好的会话）。
   * 整理要模型读邮件、写总结，插件自己没有模型，所以只能这样把活儿交给 Agent。
   * @param {{ cwd?: string }} request
   */
  async runNow(request) {
    const state = await this.store.readState()
    const ready = state.accounts.filter((account) => account.host !== '' && account.user !== '')
    if (ready.length === 0) {
      throw new Error('还没有邮箱，先到「配置」添加。')
    }
    const schedule = scheduleService(this.ctx)
    if (schedule === undefined || typeof schedule.create !== 'function') {
      throw new Error('这个组合没有计划任务服务，手动整理不可用。')
    }

    // 自动整理已经投递过的话，它那条任务的目标就变成了固定会话，手动跑也投到那里。
    let sessionId = ''
    if (state.auto.scheduleId !== '') {
      try {
        const entry = await schedule.view({ id: state.auto.scheduleId })
        const target = entry?.target
        if (target !== undefined && target !== null && target.kind === 'session' && typeof target.sessionId === 'string') {
          sessionId = target.sessionId
        }
      } catch {
        // 查不到就按新会话处理
      }
    }

    const target = sessionId !== ''
      ? { kind: 'session', sessionId }
      : { kind: 'new_once', create: typeof request?.cwd === 'string' && request.cwd !== '' ? { cwd: request.cwd } : {} }
    const entry = await schedule.create({
      title: '邮件整理（手动）',
      prompt: DIGEST_PROMPT,
      timing: { kind: 'after', after_seconds: 5 },
      target,
    })

    return {
      scheduled: true,
      scheduleId: entry?.id ?? '',
      sessionId: sessionId !== '' ? sessionId : (entry?.target?.sessionId ?? ''),
      accounts: ready.length,
      note: `已排上：稍后整理 ${ready.length} 个邮箱。`,
    }
  }

  /**
   * 开关自动整理：真去建/删 DSH 计划任务，再把 scheduleId 存起来。
   * @param {{ enabled?: boolean, everySeconds?: number, cwd?: string }} request
   */
  async auto(request) {
    const state = await this.store.readState()
    const enabled = request?.enabled === undefined ? state.auto.enabled : request.enabled === true
    const everySeconds = typeof request?.everySeconds === 'number' && Number.isFinite(request.everySeconds)
      ? Math.max(3600, Math.min(604800, Math.round(request.everySeconds)))
      : state.auto.everySeconds
    const mode = request?.mode === 'daily' || request?.mode === 'every' ? request.mode : state.auto.mode
    const at = typeof request?.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(request.at) ? request.at : state.auto.at
    const cwd = typeof request?.cwd === 'string' ? request.cwd : ''
    let error = ''
    let scheduleId = state.auto.scheduleId

    if (enabled) {
      const result = await ensureSchedule(this.ctx, { scheduleId, mode, everySeconds, at, cwd })
      if (result.scheduleId !== undefined && result.scheduleId !== '') scheduleId = result.scheduleId
      if (result.error !== undefined) error = result.error
      if (result.supported === false) error = result.error ?? '计划任务服务不可用。'
    } else if (scheduleId !== '') {
      await removeSchedule(this.ctx, scheduleId)
      scheduleId = ''
    }

    const auto = {
      ...state.auto,
      enabled: enabled && error === '',
      mode,
      at,
      everySeconds,
      scheduleId,
      lastError: error,
    }
    await this.store.writeState({ ...state, auto })
    return { auto, error }
  }

  dispose() {
    this.running = false
  }
}

/** 标签清单：沿用已有 id，新 id 在「已有 + 本批」里取第一个不冲突的。 */
function allocateTags(current, incoming) {
  const existing = new Set(current.map((tag) => tag.id))
  const assigned = new Set()
  const next = []
  for (const item of incoming) {
    if (item === null || typeof item !== 'object') continue
    const name = String(item.name ?? '').trim().slice(0, 24)
    if (name === '') continue
    if (next.some((tag) => tag.name.toLowerCase() === name.toLowerCase())) continue
    let id = String(item.id ?? '').trim()
    if (id === '') {
      let base = slugify(name)
      if (base === '' || /^t-/.test(base)) base = 'tag'
      id = base
      let index = 2
      while (existing.has(id) || assigned.has(id)) {
        id = `${base}-${index}`
        index += 1
      }
    } else {
      normalizeTag({ id, name }, { takenIds: [...assigned] })
    }
    assigned.add(id)
    next.push({ id, name })
  }
  return next
}

function uniqueReportId(base, taken) {
  if (!taken.includes(base)) return base
  let index = 2
  while (taken.includes(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}

/** 读报告正文；文件被手动删掉时由调用方兜底。 */
async function readReportFile(path) {
  return readFile(path, 'utf8')
}

export { accountIdFor }

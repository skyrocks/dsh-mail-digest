// IMAP 抓取：连服务器、按时间窗口搜索、把邮件连同会话头一起解析出来。
//
// 这一层只做「取信 + 解析」，不碰存储、不碰界面；service.js 负责去重、归线程与落盘。
// 依赖 imapflow（纯 JS，走 socket/TLS）和 mailparser（解析 MIME）。
// 取信用 BODY.PEEK，不会把邮箱里的信标成已读。
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'

import { messageKey } from './store.js'

/** 一次连接的公共参数；密码只在这里用，绝不进日志。 */
function connectOptions(account, password) {
  return {
    host: account.host,
    port: account.port,
    secure: account.secure !== false,
    auth: { user: account.user, pass: password },
    logger: false,
    greetingTimeout: 20000,
    socketTimeout: 180000,
  }
}

/** HTML 兜底：去标签、收空白。只在没有纯文本正文时用。 */
function textFromHtml(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function firstAddress(envelope) {
  const list = envelope?.from
  if (!Array.isArray(list) || list.length === 0) return { from: '', fromName: '' }
  const item = list[0] ?? {}
  return {
    from: typeof item.address === 'string' ? item.address : '',
    fromName: typeof item.name === 'string' ? item.name : '',
  }
}

function recipients(envelope) {
  const list = envelope?.to
  if (!Array.isArray(list)) return ''
  return list.map((item) => item?.address).filter((value) => typeof value === 'string').join(', ')
}

function referencesOf(parsed) {
  const value = parsed?.references
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string').map((item) => item.trim())
  if (typeof value === 'string') return value.split(/\s+/).filter((item) => item !== '')
  return []
}

/**
 * 试连一次：能登录、能打开收件箱就算通。
 * @param {object} account - normalizeAccount 的结果。
 * @param {string} password
 * @returns {Promise<{ ok: boolean, elapsedMs: number, messageCount?: number, error?: string }>}
 */
export async function verifyAccount(account, password) {
  const started = Date.now()
  const client = new ImapFlow(connectOptions(account, password))
  try {
    await client.connect()
    const status = await client.status(account.mailbox, { messages: true })
    return { ok: true, elapsedMs: Date.now() - started, messageCount: status.messages ?? 0 }
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    try {
      await client.logout()
    } catch {
      // 连接可能已经断了，忽略
    }
  }
}

/**
 * 抓一段时间窗口里的邮件并解析。
 * @param {object} account - normalizeAccount 的结果。
 * @param {string} password
 * @param {{ knownKeys?: Set<string>, limit?: number }} options - 已经存过的指纹，命中就跳过。
 * @returns {Promise<{ messages: object[], scanned: number, skipped: number }>}
 */
export async function fetchMessages(account, password, options = {}) {
  const known = options.knownKeys instanceof Set ? options.knownKeys : new Set()
  const limit = Math.min(Math.max(1, options.limit ?? account.limit ?? 100), 500)
  const client = new ImapFlow(connectOptions(account, password))
  const collected = []
  let scanned = 0
  let skipped = 0

  try {
    await client.connect()
    const lock = await client.getMailboxLock(account.mailbox)
    try {
      const criteria = {}
      if ((account.days ?? 0) > 0) {
        criteria.since = new Date(Date.now() - account.days * 24 * 60 * 60 * 1000)
      }
      if (account.unseenOnly === true) criteria.seen = false
      // 发件人/主题过滤放到服务端 SEARCH，这样「最新 N 封」是在筛过的结果里取的。
      // 有些服务器不认中文 SUBJECT，失败就退回只按时间窗筛。
      const hasText = (account.fromFilter ?? '') !== '' || (account.subjectFilter ?? '') !== ''
      if ((account.fromFilter ?? '') !== '') criteria.from = account.fromFilter
      if ((account.subjectFilter ?? '') !== '') criteria.subject = account.subjectFilter

      // search 默认返回序号；要 UID 必须显式声明，否则后面按 UID 取会错位。
      let found
      try {
        found = await client.search(criteria, { uid: true })
      } catch (error) {
        if (!hasText) throw error
        const fallback = {}
        if (criteria.since !== undefined) fallback.since = criteria.since
        if (criteria.seen !== undefined) fallback.seen = criteria.seen
        found = await client.search(fallback, { uid: true })
      }

      const uids = Array.isArray(found) ? found.slice(-limit) : []
      scanned = Array.isArray(found) ? found.length : 0
      if (uids.length === 0) return { messages: [], scanned, skipped }

      const needleFrom = (account.fromFilter ?? '').toLowerCase()
      const needleSubject = (account.subjectFilter ?? '').toLowerCase()
      const wanted = []

      for await (const message of client.fetch(uids.join(','), { envelope: true, source: true }, { uid: true })) {
        const { from, fromName } = firstAddress(message.envelope)
        const subject = typeof message.envelope?.subject === 'string' ? message.envelope.subject : ''
        if (needleFrom !== '' && !from.toLowerCase().includes(needleFrom)) continue
        if (needleSubject !== '' && !subject.toLowerCase().includes(needleSubject)) continue
        const messageId = typeof message.envelope?.messageId === 'string' ? message.envelope.messageId : ''
        const date = message.envelope?.date instanceof Date
          ? message.envelope.date.toISOString()
          : new Date().toISOString()
        const key = messageKey({ messageId, from, subject, date })
        if (known.has(key)) {
          skipped += 1
          continue
        }
        wanted.push({ key, message, from, fromName, subject, date, messageId })
      }

      for (const item of wanted) {
        let text = ''
        let attachments = []
        let parsed = null
        try {
          parsed = await simpleParser(item.message.source)
          text = typeof parsed.text === 'string' && parsed.text.trim() !== ''
            ? parsed.text
            : textFromHtml(parsed.html ?? parsed.textAsHtml ?? '')
          attachments = Array.isArray(parsed.attachments)
            ? parsed.attachments.map((file) => file.filename).filter((name) => typeof name === 'string')
            : []
        } catch {
          // 解析失败的邮件仍然保留信封信息，正文留空，界面上能人工看一眼。
          parsed = null
        }
        const messageId = typeof parsed?.messageId === 'string' && parsed.messageId !== ''
          ? parsed.messageId
          : item.messageId
        const inReplyTo = typeof parsed?.inReplyTo === 'string' ? parsed.inReplyTo : ''
        collected.push({
          id: item.key,
          messageId,
          inReplyTo,
          references: referencesOf(parsed),
          from: item.from,
          fromName: item.fromName,
          to: recipients(item.message.envelope),
          subject: item.subject,
          date: item.date,
          text,
          attachments,
        })
      }

      return { messages: collected, scanned, skipped }
    } finally {
      lock.release()
    }
  } finally {
    try {
      await client.logout()
    } catch {
      // 已断开时 logout 会抛，忽略
    }
  }
}

// 线程归并：靠邮件头（Message-ID / In-Reply-To / References）连成一条线，
// 没有邮件头的（转发、客户端不带 header）退回「同一主题 + 有共同联系人」。
//
// 多个邮箱时线程按账号隔离：同一件事在两个邮箱里各收到一份，也不会被并成一条。
// 纯函数，不碰存储：service 负责把结果写回 threads.json，并保留已有的总结。

const PREFIX = /^\s*(?:re|fw|fwd|aw|sv|回复|答复|转发)\s*[:：]\s*/i

/** 去掉 Re:/Fwd:/回复: 之类的层叠前缀，压空白，转小写。 */
export function subjectKey(subject) {
  let text = String(subject ?? '').trim()
  for (let i = 0; i < 8; i += 1) {
    const next = text.replace(PREFIX, '')
    if (next === text) break
    text = next
  }
  return text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 160)
}

/** 从 References / In-Reply-To 里取出干净的 id。 */
export function referenceIds(message) {
  const list = []
  if (typeof message.inReplyTo === 'string' && message.inReplyTo.trim() !== '') list.push(message.inReplyTo.trim())
  if (Array.isArray(message.references)) {
    for (const item of message.references) {
      if (typeof item === 'string' && item.trim() !== '') list.push(item.trim())
    }
  }
  return list
}

/** 联系人集合：发件人 + 收件人（小写地址）。 */
export function participantsOf(message) {
  const set = new Set()
  for (const value of [message.from, ...String(message.to ?? '').split(',')]) {
    const address = String(value ?? '').trim().toLowerCase()
    if (address !== '') set.add(address)
  }
  return set
}

class UnionFind {
  constructor() {
    this.parent = new Map()
  }

  add(node) {
    if (!this.parent.has(node)) this.parent.set(node, node)
    return node
  }

  find(node) {
    let current = this.add(node)
    while (this.parent.get(current) !== current) {
      this.parent.set(current, this.parent.get(this.parent.get(current)))
      current = this.parent.get(current)
    }
    return current
  }

  union(left, right) {
    const a = this.find(left)
    const b = this.find(right)
    if (a !== b) this.parent.set(b, a)
  }
}

/**
 * 把邮件归并成线程。
 * @param {object[]} messages - 任意顺序的邮件记录。
 * @returns {{ threads: object[], byMessage: Map<string, string> }}
 */
export function buildThreads(messages) {
  const uf = new UnionFind()
  const usable = messages.filter((message) => message !== null && typeof message === 'object' && typeof message.id === 'string')

  const scopeOf = (message) => String(message.accountId ?? '');
  const nodeOf = (message) => `m:${scopeOf(message)}:${message.id}`;

  for (const message of usable) {
    uf.add(nodeOf(message))
    const scope = scopeOf(message);
    const anchors = referenceIds(message);
    for (const reference of anchors) uf.union(nodeOf(message), `r:${scope}:${reference}`);
    if (typeof message.messageId === 'string' && message.messageId !== '') {
      uf.union(nodeOf(message), `r:${scope}:${message.messageId}`);
    }
  }

  // 组件 → 邮件
  const components = new Map()
  for (const message of usable) {
    const root = uf.find(nodeOf(message))
    if (!components.has(root)) components.set(root, [])
    components.get(root).push(message)
  }

  // 没有邮件头的回退：主题相同 + 联系人相交，才当作同一线程。
  const bySubject = new Map()
  for (const [root, group] of components) {
    const key = subjectKey(group[0]?.subject)
    if (key === '') continue
    if (!bySubject.has(key)) bySubject.set(key, [])
    bySubject.get(key).push({ root, group })
  }
  const merged = new Map()
  for (const [, entries] of bySubject) {
    const clusters = []
    for (const entry of entries) {
      const contacts = new Set()
      for (const message of entry.group) for (const person of participantsOf(message)) contacts.add(person)
      let placed = false
      for (const cluster of clusters) {
        if ([...contacts].some((person) => cluster.contacts.has(person))) {
          cluster.entries.push(entry)
          for (const person of contacts) cluster.contacts.add(person)
          placed = true
          break
        }
      }
      if (!placed) clusters.push({ entries: [entry], contacts })
    }
    for (const cluster of clusters) {
      const roots = cluster.entries.map((entry) => entry.root)
      for (const root of roots) merged.set(root, roots[0])
    }
  }

  const threads = []
  const byMessage = new Map()
  const finalGroups = new Map()
  for (const [root, group] of components) {
    const target = merged.get(root) ?? root
    if (!finalGroups.has(target)) finalGroups.set(target, [])
    finalGroups.get(target).push(...group)
  }

  for (const [, group] of finalGroups) {
    const sorted = [...group].sort((a, b) => String(a.date).localeCompare(String(b.date)))
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    // key 取「账号 + 最早那封的指纹」，稳定且可读；新来更早的信会改 key，service 会按主题接续老总结。
    const key = `t:${first.accountId ?? ''}:${first.id}`
    const participants = []
    const seen = new Set()
    for (const message of sorted) {
      const name = message.fromName !== '' && message.fromName !== undefined ? message.fromName : message.from
      if (typeof name === 'string' && name !== '' && !seen.has(name)) {
        seen.add(name)
        participants.push(name)
      }
    }
    const thread = {
      key,
      accountId: first.accountId ?? '',
      subjectKey: subjectKey(first.subject),
      subject: first.subject,
      participants: participants.slice(0, 8),
      firstAt: first.date,
      lastAt: last.date,
      count: sorted.length,
      messageIds: sorted.map((message) => message.id),
    }
    threads.push(thread)
    for (const message of sorted) byMessage.set(message.id, key)
  }

  threads.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)))
  return { threads, byMessage }
}

/**
 * 把旧的总结接到新算出来的线程上。
 * 先按 key 对上；对不上再按「主题 + 有共同联系人」找一条最像的。
 * @param {object} previous - threads.json 里的旧对象（key → thread）。
 * @param {object[]} threads - buildThreads 的新结果。
 * @returns {object[]} 带 summary 字段的线程。
 */
export function carrySummaries(previous, threads) {
  const old = previous !== null && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}
  const used = new Set()
  const result = threads.map((thread) => ({ ...thread, summary: '', summarizedAt: '', summaryCount: 0 }))

  for (const thread of result) {
    const hit = old[thread.key]
    if (hit !== undefined && hit.summary) {
      thread.summary = String(hit.summary)
      thread.summarizedAt = String(hit.summarizedAt ?? '')
      thread.summaryCount = Number.isFinite(hit.summaryCount) ? hit.summaryCount : 0
      used.add(thread.key)
    }
  }

  for (const thread of result) {
    if (thread.summary !== '') continue
    const contacts = new Set()
    for (const name of thread.participants) contacts.add(name.toLowerCase())
    for (const [key, hit] of Object.entries(old)) {
      if (used.has(key) || !hit || !hit.summary) continue
      if (hit.subjectKey !== thread.subjectKey) continue
      const hitContacts = Array.isArray(hit.participants)
        ? hit.participants.map((name) => String(name).toLowerCase())
        : []
      const overlap = hitContacts.some((name) => (
        name !== '' && [...contacts].some((person) => person === name || person.includes(name) || name.includes(person))
      ))
      if (!overlap) continue
      thread.summary = String(hit.summary)
      thread.summarizedAt = String(hit.summarizedAt ?? '')
      thread.summaryCount = Number.isFinite(hit.summaryCount) ? hit.summaryCount : 0
      used.add(key)
      break
    }
  }

  return result
}

// 报告：从这一轮的邮件和线程里提炼「重点」，不逐封罗列。
//
// 三份产物，同一份内容：
//   reports/<id>.json  - 结构化的，侧边栏面板直接渲染
//   reports/<id>.html  - 自带样式的网页，浏览器里看
//   reports/<id>.md    - 纯文本，给模型和终端看

function pad(value) {
  return String(value).padStart(2, '0')
}

/** 本地 YYYY-MM-DD HH:mm。 */
export function localStamp(input) {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 本地 YYYYMMDD-HHmmss（报告 id 用）。 */
export function localId(input) {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** 只到天的短时间。 */
export function shortStamp(input) {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return ''
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${sameYear ? day : `${date.getFullYear()}-${day}`} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function oneLine(text, width) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`
}

function who(message) {
  const name = message.fromName !== '' && message.fromName !== undefined ? message.fromName : message.from
  return String(name ?? '未知发件人')
}

/** 报告标题：默认「邮件整理 · 账号 · 时间」。 */
export function reportTitle(createdAt, accountName) {
  const name = String(accountName ?? '').trim()
  return name === ''
    ? `邮件整理 · ${localStamp(createdAt)}`
    : `邮件整理 · ${name} · ${localStamp(createdAt)}`
}

const MAX_FOCUS = 5
const MAX_PENDING = 8
const MAX_THREADS = 6

/**
 * 把一轮整理压成一份摘要。
 * @param {{
 *   id: string, createdAt: string, account: {name?: string, user?: string},
 *   messages: object[], threads: object[], threadMessages: Map<string, object[]>,
 *   stats: object, overview?: string, focus?: Array<{title: string, detail?: string}>,
 *   ignored: number,
 * }} input
 */
export function buildReportContent(input) {
  const createdAt = input.createdAt
  const stats = input.stats ?? {}
  const messages = Array.isArray(input.messages) ? input.messages : []
  const threads = Array.isArray(input.threads) ? input.threads : []
  const threadMessages = input.threadMessages instanceof Map ? input.threadMessages : new Map()
  const account = input.account ?? {}

  // 需要处理：要回复 / 高优先级 / 有明确待办的
  const actionable = messages
    .filter((message) => message.needsReply === true || message.priority === 'high')
    .sort((a, b) => {
      const rank = (message) => (message.priority === 'high' ? 0 : 1) + (message.needsReply === true ? 0 : 2)
      return rank(a) - rank(b) || String(b.date).localeCompare(String(a.date))
    })

  const pending = actionable.slice(0, MAX_PENDING).map((message) => ({
    id: message.id,
    subject: oneLine(message.subject, 80),
    from: who(message),
    date: shortStamp(message.date),
    tags: Array.isArray(message.tags) ? message.tags.slice(0, 3) : [],
    needsReply: message.needsReply === true,
    priority: message.priority ?? 'normal',
    summary: oneLine(message.summary, 140)
  }))

  // 有进展的线程：只留真正的来往（2 封以上），单封的已经在「需要处理 / 其余」里了
  const activeThreads = threads
    .filter((thread) => (thread.count ?? 0) > 1)
    .map((thread) => {
      const list = threadMessages.get(thread.key) ?? []
      return {
        key: thread.key,
        subject: oneLine(thread.subject, 90),
        count: thread.count ?? list.length,
        newCount: list.filter((message) => message.__isNew === true).length,
        firstAt: shortStamp(thread.firstAt),
        lastAt: shortStamp(thread.lastAt),
        participants: (thread.participants ?? []).slice(0, 4),
        summary: oneLine(thread.summary, 400),
        stale: typeof thread.summaryCount === 'number' && thread.summaryCount < (thread.count ?? 0)
      }
    })
    .sort((a, b) => (b.newCount - a.newCount) || String(b.lastAt).localeCompare(String(a.lastAt)))

  const shownThreads = activeThreads.slice(0, MAX_THREADS)

  // 其余邮件：只留标题，给人「都在这里」的底
  const actionableIds = new Set(actionable.map((message) => message.id))
  const restAll = messages.filter((message) => !actionableIds.has(message.id))
  const rest = restAll
    .slice(0, 20)
    .map((message) => ({
      subject: oneLine(message.subject, 80),
      from: who(message),
      date: shortStamp(message.date),
      tags: Array.isArray(message.tags) ? message.tags.slice(0, 2) : []
    }))

  const tagCount = new Map()
  for (const message of messages) {
    for (const tag of message.tags ?? []) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1)
  }
  const tags = [...tagCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }))

  const focus = (Array.isArray(input.focus) ? input.focus : [])
    .filter((item) => item !== null && typeof item === 'object' && String(item.title ?? '').trim() !== '')
    .slice(0, MAX_FOCUS)
    .map((item) => ({
      title: oneLine(item.title, 120),
      detail: oneLine(item.detail ?? '', 240)
    }))

  return {
    id: input.id,
    accountId: input.accountId ?? '',
    createdAt,
    title: reportTitle(createdAt, account.name || account.user),
    account: { name: account.name ?? '', user: account.user ?? '' },
    overview: oneLine(input.overview ?? '', 400),
    focus,
    stats: {
      newMessages: stats.newMessages ?? messages.length,
      newThreads: stats.newThreads ?? 0,
      activeThreads: stats.activeThreads ?? threads.length,
      needReply: stats.needReply ?? actionable.filter((message) => message.needsReply === true).length,
      high: stats.high ?? messages.filter((message) => message.priority === 'high').length,
      ignored: Math.max(0, Number(input.ignored ?? 0)),
      shownThreads: shownThreads.length,
      totalThreads: activeThreads.length
    },
    tags,
    pending,
    morePending: Math.max(0, actionable.length - pending.length),
    threads: shownThreads,
    moreThreads: Math.max(0, activeThreads.length - shownThreads.length),
    rest,
    moreRest: Math.max(0, restAll.length - rest.length)
  }
}

/** 一段给人看的统计句。 */
export function reportSummaryText(content) {
  const stats = content?.stats ?? {}
  const parts = []
  if (typeof stats.newMessages === 'number') parts.push(`${stats.newMessages} 封新邮件`)
  if (typeof stats.needReply === 'number' && stats.needReply > 0) parts.push(`${stats.needReply} 封待回复`)
  if (typeof stats.high === 'number' && stats.high > 0) parts.push(`${stats.high} 封高优先级`)
  return parts.join(' · ')
}

// ── Markdown ────────────────────────────────────────────────────────────────

/** @param {object} content - buildReportContent 的结果 */
export function renderReportMarkdown(content) {
  const lines = [`# ${content.title}`, '']
  if (content.overview !== '') lines.push(content.overview, '')

  lines.push(`> ${reportSummaryText(content) || `${content.stats.newMessages} 封新邮件`}`
    + `${content.stats.ignored > 0 ? `；另有 ${content.stats.ignored} 封噪音/忽略` : ''}`, '')

  if (content.focus.length > 0) {
    lines.push('## 重点', '')
    for (const item of content.focus) {
      lines.push(`- **${item.title}**${item.detail === '' ? '' : `：${item.detail}`}`)
    }
    lines.push('')
  }

  if (content.pending.length > 0) {
    lines.push('## 需要你处理', '')
    for (const item of content.pending) {
      const flags = []
      if (item.priority === 'high') flags.push('高')
      if (item.needsReply) flags.push('待回复')
      lines.push(`- ${item.subject} · ${item.from} · ${item.date}${flags.length === 0 ? '' : ` · ${flags.join('/')}`}`)
      if (item.summary !== '') lines.push(`  - ${item.summary}`)
    }
    if (content.morePending > 0) lines.push(`- 另有 ${content.morePending} 封同类，见文末`)
    lines.push('')
  }

  if (content.threads.length > 0) {
    lines.push('## 线程进展', '')
    for (const thread of content.threads) {
      const span = thread.firstAt === thread.lastAt ? thread.firstAt : `${thread.firstAt} → ${thread.lastAt}`
      lines.push(`### ${thread.subject}（${thread.count} 封，${span}${thread.newCount > 0 ? `，本轮 +${thread.newCount}` : ''}）`)
      lines.push('')
      lines.push(thread.summary === ''
        ? '**总结**：（暂无）'
        : `**总结**：${thread.summary}${thread.stale ? '（未含最新几封）' : ''}`)
      lines.push('')
    }
    if (content.moreThreads > 0) lines.push(`（另有 ${content.moreThreads} 条线程有变动）`, '')
  }

  if (content.tags.length > 0) {
    lines.push('## 这批邮件是什么', '')
    lines.push(content.tags.map((tag) => `${tag.name} ${tag.count}`).join(' · '), '')
  }

  if (content.rest.length > 0) {
    // 结尾只给个底：列 10 条，其余留到网页版。
    const listed = content.rest.slice(0, 10)
    lines.push('## 其余（只列标题）', '')
    for (const item of listed) {
      lines.push(`- ${item.date} · ${item.from} · ${item.subject}`)
    }
    const remaining = content.rest.length - listed.length + (content.moreRest ?? 0)
    if (remaining > 0) lines.push(`- ……另有 ${remaining} 封，见网页版`)
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

// ── HTML ────────────────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 自带样式的单页报告，双击就能在浏览器里看。 */
export function renderReportHtml(content) {
  const chips = content.tags.map((tag) => `<span class="chip">${escapeHtml(tag.name)} <b>${tag.count}</b></span>`).join('')

  const focus = content.focus.length === 0
    ? ''
    : `<section><h2>重点</h2><ol class="focus">${content.focus.map((item) => (
      `<li><b>${escapeHtml(item.title)}</b>${item.detail === '' ? '' : `<span>${escapeHtml(item.detail)}</span>`}</li>`
    )).join('')}</ol></section>`

  const pending = content.pending.length === 0
    ? ''
    : `<section><h2>需要你处理 <small>${content.stats.needReply} 封待回复 · ${content.stats.high} 封高优先级</small></h2><ul class="pending">${content.pending.map((item) => (
      `<li><div class="row"><span class="subj">${escapeHtml(item.subject)}</span>`
      + `${item.priority === 'high' ? '<span class="badge high">高</span>' : ''}`
      + `${item.needsReply ? '<span class="badge reply">待回复</span>' : ''}</div>`
      + `<div class="meta">${escapeHtml(item.from)} · ${escapeHtml(item.date)}${item.tags.length === 0 ? '' : ` · ${item.tags.map(escapeHtml).join(' / ')}`}</div>`
      + `${item.summary === '' ? '' : `<div class="note">${escapeHtml(item.summary)}</div>`}</li>`
    )).join('')}</ul>${content.morePending > 0 ? `<p class="more">另有 ${content.morePending} 封同类，见文末。</p>` : ''}</section>`

  const threads = content.threads.length === 0
    ? ''
    : `<section><h2>线程进展 <small>${content.stats.shownThreads}/${content.stats.totalThreads} 条</small></h2>${content.threads.map((thread) => (
      `<article class="thread"><h3>${escapeHtml(thread.subject)}</h3>`
      + `<div class="meta">${thread.count} 封 · ${escapeHtml(thread.firstAt)}${thread.firstAt === thread.lastAt ? '' : ` → ${escapeHtml(thread.lastAt)}`}`
      + `${thread.newCount > 0 ? ` · 本轮 +${thread.newCount}` : ''}${thread.participants.length === 0 ? '' : ` · ${escapeHtml(thread.participants.join('、'))}`}</div>`
      + `<p>${thread.summary === '' ? '（暂无总结）' : escapeHtml(thread.summary)}`
      + `${thread.stale ? '<em>（未含最新几封）</em>' : ''}</p></article>`
    )).join('')}${content.moreThreads > 0 ? `<p class="more">另有 ${content.moreThreads} 条线程有变动。</p>` : ''}</section>`

  const rest = content.rest.length === 0
    ? ''
    : `<details><summary>其余 ${content.rest.length} 封（只列标题）</summary><ul class="rest">${content.rest.map((item) => (
      `<li><span>${escapeHtml(item.date)}</span><span>${escapeHtml(item.from)}</span><span>${escapeHtml(item.subject)}</span></li>`
    )).join('')}</ul>${content.moreRest > 0 ? `<p class="more">另有 ${content.moreRest} 封未列。</p>` : ''}</details>`

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(content.title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 40px 24px 64px; font: 15px/1.7 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
         background: Canvas; color: CanvasText; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .lede { margin: 0 0 4px; font-size: 16px; }
  .stamp { color: color-mix(in srgb, CanvasText 55%, Canvas); font-size: 13px; }
  h2 { font-size: 15px; letter-spacing: .04em; text-transform: none; margin: 32px 0 12px;
       padding-bottom: 6px; border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, Canvas); }
  h2 small { font-weight: 400; font-size: 12px; color: color-mix(in srgb, CanvasText 50%, Canvas); margin-left: 8px; }
  h3 { font-size: 15px; margin: 18px 0 4px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 16px 0 0; }
  .chip { font-size: 12px; padding: 2px 9px; border-radius: 999px; border: 1px solid color-mix(in srgb, CanvasText 16%, Canvas); }
  .chip b { font-weight: 600; margin-left: 4px; }
  ol.focus { margin: 0; padding-left: 22px; }
  ol.focus li { margin: 8px 0; }
  ol.focus li span { display: block; color: color-mix(in srgb, CanvasText 62%, Canvas); font-size: 13.5px; }
  ul.pending { list-style: none; margin: 0; padding: 0; }
  ul.pending li { padding: 10px 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, Canvas); }
  ul.pending li:last-child { border-bottom: 0; }
  .row { display: flex; align-items: center; gap: 8px; }
  .subj { font-weight: 600; }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 999px; }
  .badge.high { background: color-mix(in srgb, #e5484d 16%, transparent); color: #c62a2f; }
  .badge.reply { background: color-mix(in srgb, #d97706 18%, transparent); color: #a15c00; }
  .meta { font-size: 12.5px; color: color-mix(in srgb, CanvasText 55%, Canvas); margin-top: 2px; }
  .note { font-size: 13.5px; color: color-mix(in srgb, CanvasText 78%, Canvas); margin-top: 4px; }
  .thread p { margin: 6px 0 0; }
  .more { font-size: 13px; color: color-mix(in srgb, CanvasText 55%, Canvas); }
  details { margin-top: 32px; }
  summary { cursor: pointer; font-weight: 600; }
  ul.rest { list-style: none; margin: 10px 0 0; padding: 0; font-size: 13px; }
  ul.rest li { display: grid; grid-template-columns: 96px 120px 1fr; gap: 10px; padding: 4px 0;
               border-bottom: 1px solid color-mix(in srgb, CanvasText 8%, Canvas); }
  ul.rest li span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (prefers-color-scheme: dark) { .badge.high { color: #ff8b8d; } .badge.reply { color: #ffb457; } }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(content.title)}</h1>
  ${content.overview === '' ? '' : `<p class="lede">${escapeHtml(content.overview)}</p>`}
  <p class="stamp">${escapeHtml(reportSummaryText(content))}${content.stats.ignored > 0 ? ` · 另有 ${content.stats.ignored} 封噪音/忽略` : ''}</p>
  ${chips === '' ? '' : `<div class="chips">${chips}</div>`}
  ${focus}
  ${pending}
  ${threads}
  ${rest}
</main>
</body>
</html>
`
}

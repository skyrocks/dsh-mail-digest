// Host 半（工具层）：把「整理邮件」这件事注册成模型工具。
//
// 流程：抓（mail_fetch）→ 看（mail_inbox / mail_read）→ 打标签写摘要（mail_file）
// → 读线程历史并总结（mail_thread / mail_thread_summary）→ 出报告（mail_report）。
// 每一步都调 service 上的同一个方法，「设置 → 邮件整理」界面走的是同一套方法。
import { localStamp } from './report.js'

/** 统一参数校验：只认声明过的字段，类型不对直接说清楚。 */
function readArgs(tool, args, spec) {
  const value = args === undefined || args === null ? {} : args
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${tool}: 参数必须是对象。`)
  }
  const allowed = Object.keys(spec)
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${tool}: 不认识的参数「${key}」；只接受 ${allowed.join(', ')}。`)
    }
  }
  const out = {}
  for (const [key, entry] of Object.entries(spec)) {
    const raw = value[key]
    const present = raw !== undefined && raw !== null && !(typeof raw === 'string' && raw.trim() === '')
    if (!present) {
      if (entry.required === true) throw new Error(`${tool}: 缺少必填参数「${key}」。`)
      continue
    }
    if (entry.type === 'number') {
      const number = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(number)) throw new Error(`${tool}: 参数「${key}」必须是数字。`)
      out[key] = number
      continue
    }
    if (entry.type === 'boolean') {
      if (typeof raw !== 'boolean') throw new Error(`${tool}: 参数「${key}」必须是布尔值。`)
      out[key] = raw
      continue
    }
    if (entry.type === 'array') {
      if (!Array.isArray(raw)) throw new Error(`${tool}: 参数「${key}」必须是数组。`)
      out[key] = raw
      continue
    }
    if (typeof raw !== 'string') throw new Error(`${tool}: 参数「${key}」必须是字符串。`)
    out[key] = raw
  }
  return out
}

function oneLine(text, width) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`
}

function who(message) {
  if (typeof message.fromName === 'string' && message.fromName !== '') {
    return `${message.fromName} <${message.from}>`
  }
  return message.from
}

const FLAG = { high: '高优先级', normal: '', low: '低优先级' }
const PRIORITY_LABEL = { high: '高', normal: '普通', low: '低' }

export function registerTools(ctx, service) {
  ctx.tools.register({
    name: 'mail_status',
    description: [
      '查看邮件整理的状态：配了哪些邮箱（各自的 accountId）、账号配好没有、有哪些标签、自动整理开着没有、每种计数多少、数据在哪。',
      '开始整理前先调它：没配账号就让用户去「设置 → 邮件整理」→「配置」加一个，别自己去改文件。',
    ].join(''),
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { note: { type: 'string' }, configured: { type: 'boolean' } },
        required: ['note', 'configured'],
      },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    async execute() {
      const status = await service.status()
      const tags = status.tags.map((tag) => tag.name).join('、')
      const auto = status.auto.enabled
        ? `开着，每 ${Math.round(status.auto.everySeconds / 3600)} 小时一次${status.auto.lastRunAt === '' ? '（还没跑过）' : `，上次 ${localStamp(status.auto.lastRunAt)}`}`
        : '关着'
      const accounts = status.accounts.map((account) => (
        `- ${account.id} · ${account.name || account.user} · ${account.user}@${account.host}:${account.port}`
        + ` · ${account.hasPassword ? '有授权码' : '⚠ 没存授权码'}`
        + ` · 未整理 ${account.counts.unfiled} / 共 ${account.counts.messages} 封 · 线程 ${account.counts.threads} · 报告 ${account.counts.reports}（未读 ${account.counts.unreadReports}）`
      ))
      const ready = status.accounts.filter((account) => account.configured && account.hasPassword)
      const note = [
        status.accounts.length === 0
          ? '还没有邮箱。让用户到「设置 → 邮件整理 → 配置」添加。'
          : `配了 ${status.accounts.length} 个邮箱，可直接抓的 ${ready.length} 个：\n${accounts.join('\n')}`,
        `自动整理：${auto}${status.auto.lastError === '' ? '' : `（上次出错：${status.auto.lastError}）`}`,
        `库里 ${status.counts.messages} 封邮件、${status.counts.threads} 条线程；未整理 ${status.counts.unfiled} 封；报告 ${status.counts.reports} 份（未读 ${status.counts.unreadReports}）。`,
        `现有标签：${tags === '' ? '（还没有）' : tags}`,
        `数据目录：${status.dir}`,
        '',
        '工具都需要 accountId（mail_status 返回的第一列）。新标签可以直接在 mail_file 里用，不必先建。',
      ].join('\n')
      return { note, configured: ready.length > 0 }
    },
  })

  ctx.tools.register({
    name: 'mail_fetch',
    description: [
      '从 IMAP 收件箱抓一次邮件，按 Message-ID 去重后存到本地，并重算线程（旧线程的总结会保留）。',
      '不传 accountId 就把所有配好的邮箱都抓一遍（自动整理那种跑法）；给了就只抓那一个。',
      '只抓配置里的时间窗口（默认近 30 天）里最新的若干封。抓完用 mail_inbox 看没整理的。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accountId: { type: 'string', description: '可选。只抓这个邮箱（取值来自 mail_status）；不传就抓全部' },
        limit: { type: 'number', description: '可选。每个账号这次最多抓几封（默认用设置的 100，上限 500）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { added: { type: 'number' }, total: { type: 'number' }, threads: { type: 'array' }, note: { type: 'string' } },
        required: ['added', 'total', 'threads', 'note'],
      },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    async execute(rawArgs) {
      const args = readArgs('mail_fetch', rawArgs, { accountId: {}, limit: { type: 'number' } })
      const result = await service.fetch({ accountId: args.accountId, limit: args.limit })
      if (result.added > 0 && Array.isArray(result.threads) && result.threads.length > 0) {
        const lines = result.threads.map((thread) => (
          `- ${oneLine(thread.subject, 50)} · ${thread.count} 封 · 最近 ${localStamp(thread.lastAt)}`
          + `${thread.needsSummary ? ' · ⚠ 这条线还没写到最新' : ''}`
        ))
        return {
          added: result.added,
          total: result.total ?? 0,
          threads: result.threads,
          note: `${result.note}\n涉及线程：\n${lines.join('\n')}\n\n下一步：mail_inbox 看新邮件；对上面标记 ⚠ 的线程先 mail_thread 读历史再 mail_thread_summary。`,
        }
      }
      return { added: result.added ?? 0, total: result.total ?? 0, threads: [], note: result.note ?? '' }
    },
  })

  ctx.tools.register({
    name: 'mail_inbox',
    description: [
      '列出邮件。默认只列「还没整理」的（status=new），按时间倒序，带正文节选和所属线程。',
      'accountId 不给就列所有邮箱（每封会带 accountId）；自动整理时建议一个账号一个账号处理。',
      '整理结果用 mail_file 写回；要读全文用 mail_read；要读整条线程用 mail_thread。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accountId: { type: 'string', description: '可选。只看这个邮箱（取值来自 mail_status）' },
        status: { type: 'string', description: '可选。new（未整理，默认）/ filed（已整理）' },
        tag: { type: 'string', description: '可选。只看带这个标签的邮件' },
        limit: { type: 'number', description: '可选。最多列几封，默认 10，上限 50' },
        withText: { type: 'boolean', description: '可选。是否带正文节选（默认带，每封最多 800 字）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { messages: { type: 'array' }, note: { type: 'string' } },
        required: ['messages', 'note'],
      },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    async execute(rawArgs) {
      const args = readArgs('mail_inbox', rawArgs, {
        accountId: {},
        status: {},
        tag: {},
        limit: { type: 'number' },
        withText: { type: 'boolean' },
      })
      const limit = Math.min(Math.max(1, args.limit ?? 10), 50)
      const listed = await service.list({
        accountId: args.accountId,
        status: args.status ?? 'new',
        tag: args.tag,
        limit: 200,
      })
      const chosen = listed.messages.slice(0, limit)

      const messages = []
      const blocks = []
      for (const message of chosen) {
        messages.push({
          id: message.id,
          accountId: message.accountId,
          from: message.from,
          fromName: message.fromName,
          subject: message.subject,
          date: message.date,
          threadKey: message.threadKey,
          tags: message.tags,
          status: message.status,
        })
        let text = ''
        if (args.withText !== false) {
          const full = await service.read({ id: message.id })
          text = String(full.message.text ?? '').slice(0, 800)
        }
        const head = `· [${message.id}]${args.accountId === undefined ? ` (${message.accountId})` : ''} ${localStamp(message.date)} · ${who(message)} · ${message.subject}`
          + `${message.threadKey === '' ? '' : ` · 线程 ${message.threadKey}`}`
        blocks.push(text === '' ? head : `${head}\n${text}`)
      }

      const note = listed.total === 0
        ? `没有${args.status === undefined ? '未整理' : args.status}的邮件。抓一批新的：mail_fetch。`
        : [
            `共 ${listed.total} 封符合条件，这里列 ${chosen.length} 封：`,
            ...blocks,
            listed.total > chosen.length ? `…… 还有 ${listed.total - chosen.length} 封，调大 limit 或加条件。` : '',
            '看完用 mail_file 写回：tags（1–3 个标签）、summary（一句话）、priority（high/normal/low）、needsReply。',
            '写完后对涉及到的线程用 mail_thread 读历史、mail_thread_summary 写总结。',
          ].filter((line) => line !== '').join('\n\n')

      return { messages, note }
    },
  })

  ctx.tools.register({
    name: 'mail_read',
    description: '读一封邮件的全文（本地库里那条记录，不是去连 IMAP），顺带给出它所属线程的总结。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'string', description: '邮件 id，来自 mail_inbox 的返回' } },
      required: ['id'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { note: { type: 'string' } },
        required: ['note'],
      },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    async execute(rawArgs) {
      const args = readArgs('mail_read', rawArgs, { id: { required: true } })
      const result = await service.read({ id: args.id })
      const message = result.message
      const flags = [FLAG[message.priority] ?? ''].filter((item) => item !== '')
      if (message.needsReply) flags.push('待回复')
      const note = [
        `${message.subject} · ${who(message)} · ${localStamp(message.date)}`,
        `${message.tags.length === 0 ? '（未打标签）' : message.tags.join('、')}${flags.length === 0 ? '' : ` · ${flags.join(' · ')}`}`
          + `${message.threadKey === '' ? '' : ` · 线程 ${message.threadKey}`}`,
        typeof message.summary === 'string' && message.summary !== '' ? `一句话：${message.summary}` : '',
        result.thread !== null && result.thread.summary !== '' ? `线程总结（${result.thread.count} 封）：${result.thread.summary}` : '',
        '',
        message.text === '' ? '（这封没有解析出正文，只有主题和发件人。）' : message.text,
      ].filter((line) => line !== '').join('\n')
      return { note }
    },
  })

  ctx.tools.register({
    name: 'mail_thread',
    description: [
      '读一整条线程（按时间正序）：这是「同一件事的来龙去脉」。写总结前必须先调它，',
      '不要只看最后一封就下结论。返回里 needsSummary=true 说明有新邮件进来、总结该更新了。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: '线程 key，来自 mail_inbox / mail_fetch 的返回' },
        id: { type: 'string', description: '也可以给邮件 id，由它反查所属线程' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { messages: { type: 'array' }, note: { type: 'string' } },
        required: ['messages', 'note'],
      },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    async execute(rawArgs) {
      const args = readArgs('mail_thread', rawArgs, { key: {}, id: {} })
      const result = await service.thread({ key: args.key, id: args.id })
      const thread = result.thread
      const lines = result.messages.map((message) => (
        `[${localStamp(message.date)}] ${who(message)} · ${message.subject}`
        + `${message.summary === '' ? '' : `\n  一句话：${message.summary}`}`
        + `\n${oneLine(message.text, 600)}`
      ))
      const note = [
        `线程：${thread.subject}（${thread.count} 封，${localStamp(thread.firstAt)} → ${localStamp(thread.lastAt)}）`,
        thread.participants.length > 0 ? `参与人：${thread.participants.join('、')}` : '',
        thread.summary === '' ? '还没有总结。' : `现有总结：${thread.summary}`,
        result.needsSummary ? '⚠ 这条线有新邮件，总结需要更新（调 mail_thread_summary）。' : '',
        '',
        lines.join('\n\n'),
      ].filter((line) => line !== '').join('\n')
      return { messages: result.messages.map(({ text: _text, ...rest }) => rest), note }
    },
  })

  ctx.tools.register({
    name: 'mail_file',
    description: [
      '把整理结果写回一封或多封邮件：标签、一句话摘要、优先级、是否要回复。',
      'tags：1–3 个短标签（可以用新词，不用先建）；summary：一句话说清「这封要我干什么」；',
      'priority：high / normal / low；needsReply：要不要我回复。',
      '写完这一封就写下一封，别攒着；一批也可以一次传数组。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        items: {
          type: 'array',
          description: '每项 { id, tags?, summary?, priority?, needsReply?, status? }',
        },
      },
      required: ['items'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { total: { type: 'number' }, note: { type: 'string' } },
        required: ['total', 'note'],
      },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    async execute(rawArgs) {
      const args = readArgs('mail_file', rawArgs, { items: { type: 'array', required: true } })
      const result = await service.file({ items: args.items })
      const lines = result.messages.map((message) => (
        `· [${message.id}] ${oneLine(message.subject, 40)} → ${message.tags.length === 0 ? '（无标签）' : message.tags.join('、')}`
        + ` · 优先级 ${PRIORITY_LABEL[message.priority] ?? message.priority}${message.needsReply ? ' · 待回复' : ''}`
        + `${message.summary === '' ? '' : ` · ${oneLine(message.summary, 40)}`}`
      ))
      return { total: result.total, note: `已写回 ${result.total} 封：\n${lines.join('\n')}` }
    },
  })

  ctx.tools.register({
    name: 'mail_thread_summary',
    description: [
      '给一条线程写「到现在的总结」：它在讲什么事、进展到哪、下一步谁该做什么。',
      '规则：先 mail_thread 读全部历史（尤其是新邮件之前的部分），再写 2–4 句；',
      '不要逐封复述，也不要漏掉之前已经确定的结论。写得像交接班记录。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: '线程 key' },
        summary: { type: 'string', description: '2–4 句中文总结' },
      },
      required: ['key', 'summary'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { note: { type: 'string' } },
        required: ['note'],
      },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    async execute(rawArgs) {
      const args = readArgs('mail_thread_summary', rawArgs, { key: { required: true }, summary: { required: true } })
      const result = await service.summarize({ key: args.key, summary: args.summary })
      return {
        note: `已更新线程总结（${result.thread.count} 封）：${oneLine(result.thread.subject, 40)}\n${result.thread.summary}`,
      }
    },
  })

  ctx.tools.register({
    name: 'mail_report',
    description: [
      '给一个邮箱生成报告：只保留「重点 / 需要处理 / 线程进展」，落盘（md + html）并登记（用户在设置里能回看、在侧边栏或浏览器里看）。',
      'accountId 必填（来自 mail_status）。',
      'overview 写一两句话概括这批邮件（用户先看这个）；focus 写 1–5 条「重点」，每条 { title, detail }，只写真要人注意的事，比如要决策的、有期限的、有风险的、金额/账号相关的。',
      '别把每封信都写进 focus；报告本身会自己列出待回复和线程进展。自动整理那一轮传 auto=true。没有新的整理结果时会直接说没有。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        accountId: { type: 'string', description: '必填。给哪个邮箱出报告（取值来自 mail_status）' },
        overview: { type: 'string', description: '一句话概括这批邮件（1–2 句，写给用户看，不是复述邮件）' },
        focus: {
          type: 'array',
          description: '1–5 条重点，每项 { title, detail? }：只写真要人注意的（要决策/有期限/有风险/涉及钱或账号）',
        },
        title: { type: 'string', description: '可选。报告标题，默认「邮件整理 · 账号 · 时间」' },
        auto: { type: 'boolean', description: '可选。true 表示这是自动整理跑出来的' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          path: { type: 'string' },
          htmlPath: { type: 'string' },
          markdown: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['id', 'title', 'path', 'htmlPath', 'markdown', 'note'],
      },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    async execute(rawArgs) {
      const args = readArgs('mail_report', rawArgs, {
        accountId: { required: true },
        overview: {},
        focus: { type: 'array' },
        title: {},
        auto: { type: 'boolean' },
      })
      const result = await service.report({
        accountId: args.accountId,
        overview: args.overview,
        focus: args.focus,
        title: args.title,
        auto: args.auto === true,
      })
      return {
        id: result.id ?? '',
        title: result.title ?? '',
        path: result.path ?? '',
        htmlPath: result.htmlPath ?? '',
        markdown: result.markdown ?? '',
        note: result.empty === true
          ? result.note
          : `${result.note}\n网页版：${result.htmlPath ?? ''}`,
      }
    },
  })

  ctx.tools.register({
    name: 'mail_reports',
    description: [
      '报告列表 / 读一份 / 删一份。action：list（默认）、read、delete；accountId 可选，只看某个邮箱的报告。',
      '用户问「上次整理了什么」「把报告都列出来」时用它；read 会把那份报告标记成已读。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: 'list / read / delete，默认 list' },
        id: { type: 'string', description: 'read / delete 时必填' },
        accountId: { type: 'string', description: '可选。只看这个邮箱的报告' },
        limit: { type: 'number', description: 'list 时最多列几份，默认 20' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { reports: { type: 'array' }, note: { type: 'string' } },
        required: ['reports', 'note'],
      },
      render: (_args, value) => [{ type: 'text', text: value.note }],
    },
    async execute(rawArgs) {
      const args = readArgs('mail_reports', rawArgs, {
        action: {},
        id: {},
        accountId: {},
        limit: { type: 'number' },
      })
      const action = args.action ?? 'list'

      if (action === 'list') {
        const result = await service.reports({ action: 'list', accountId: args.accountId, limit: args.limit ?? 20 })
        const lines = result.reports.map((report) => (
          `- [${report.id}] ${report.title} · ${report.messages} 封 / ${report.threads} 条线程`
          + `${report.unread ? ' · 未读' : ''}${report.summary === '' ? '' : ` · ${report.summary}`}`
        ))
        return {
          reports: result.reports,
          note: result.total === 0
            ? '还没有报告。抓邮件、整理后用 mail_report 生成。'
            : `共 ${result.total} 份（未读 ${result.unread}）：\n${lines.join('\n')}`,
        }
      }

      if (action === 'read') {
        const result = await service.reports({ action: 'read', id: args.id })
        return { reports: [result.report], note: result.markdown }
      }

      if (action === 'delete') {
        const result = await service.reports({ action: 'delete', id: args.id })
        return {
          reports: [],
          note: result.removed
            ? `已删除报告 ${args.id}${result.restored > 0 ? `；这一批 ${result.restored} 封邮件退回待整理，下次生成报告会重新收进去（标签和摘要都还在）` : ''}。`
            : `没有删掉 ${args.id}。`,
        }
      }

      throw new Error(`mail_reports: 不认识的 action「${action}」（list / read / delete）。`)
    },
  })
}

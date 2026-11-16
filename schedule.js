// 自动整理的调度：把周期写进 DSH 的计划任务（ctx.schedule）。
//
// 为什么用计划任务而不是插件自己的定时器：整理要模型读邮件、写标签和线程总结，
// 插件里没有模型；交给计划任务触发一次 Agent 回合，用的就是用户当前配的模型。
// 目标固定为「第一次触发时创建、之后复用同一个会话」，不会每次开新会话。

export const DIGEST_PROMPT = [
  '[邮件整理] 请把配好的邮箱都整理一遍：',
  '1) 先调 mail_status 拿账号列表（accountId）；一个能用的都没有就只回一句原因，不要往下猜。',
  '2) 对每个账号依次做：',
  '   a. mail_fetch({accountId}) 抓这个账号的新邮件；',
  '   b. mail_inbox({accountId}) 看未整理的，每封都用 mail_file 打 1–3 个标签、写一句话摘要、标优先级和是否要回复；',
  '   c. 对每封所在线程，先 mail_thread 读整条历史（含以前的往来），再用 mail_thread_summary 写「这条线到现在的总结」——这是重点，别只写最后一封；',
  '   d. mail_report({accountId, overview, focus, auto:true}) 给这个账号出报告：',
  '      overview 用一两句概括这批邮件；focus 只写 1–5 条真要人注意的事（要决策 / 有期限 / 有风险 / 涉及钱或账号），',
  '      每条 { title, detail }——不要把每封信都写进去，用户要先看这一小段。返回说没有新内容就跳过。',
  '3) 全部跑完用两三句话回复：每个账号各新增多少封、哪几条线程有进展、有什么需要我回复或处理。',
  '约束：只读邮箱，不回信、不删信、不改已读状态。',
].join('\n')

export const DIGEST_TITLE = '邮件整理'

/** 取可选的计划任务服务；没有就返回 undefined（例如 headless 组合）。 */
export function scheduleService(ctx) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('schedule') : undefined
    return service !== undefined && service !== null && typeof service.create === 'function' ? service : undefined
  } catch {
    return undefined
  }
}

/** 本机时区，写成 IANA 名字（每天几点这种规则要它）。 */
function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** 把 { mode, everySeconds, at } 变成计划任务要的 timing。 */
export function timingFor(options) {
  if (options.mode === 'daily') {
    const raw = typeof options.at === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(options.at) ? options.at : '09:00'
    return { kind: 'daily', daily: { time: `${raw}:00`, time_zone: localTimeZone() } }
  }
  const everySeconds = Math.max(3600, Math.min(604800, Math.round(options.everySeconds ?? 21600)))
  return { kind: 'every', every_seconds: everySeconds }
}

/**
 * 创建或更新周期任务。
 * @param {object} ctx
 * @param {{ scheduleId?: string, mode?: 'every'|'daily', everySeconds?: number, at?: string, cwd?: string }} options
 * @returns {Promise<{ supported: boolean, scheduleId?: string, error?: string }>}
 */
export async function ensureSchedule(ctx, options) {
  const schedule = scheduleService(ctx)
  if (schedule === undefined) {
    return { supported: false, error: '这个 DSH 组合没有挂载计划任务服务（ctx.schedule），自动整理开不了；手动「抓取」仍然可用。' }
  }
  const timing = timingFor(options)
  const existing = typeof options.scheduleId === 'string' && options.scheduleId !== '' ? options.scheduleId : ''

  if (existing !== '') {
    try {
      const result = await schedule.edit({
        id: existing,
        action: 'update',
        patch: { title: DIGEST_TITLE, prompt: DIGEST_PROMPT, timing },
      })
      if (result !== undefined && result.code === 'schedule_not_found') {
        // 用户把任务删了，下面重新建一个。
      } else {
        return { supported: true, scheduleId: existing }
      }
    } catch (error) {
      // 更新失败（例如规则被拒）就走重建，别把插件卡死在旧任务上。
      const reason = error instanceof Error ? error.message : String(error)
      const created = await createSchedule(schedule, timing, options.cwd)
      return created.error === undefined ? created : { ...created, error: `${reason}；${created.error}` }
    }
  }

  return createSchedule(schedule, timing, options.cwd)
}

async function createSchedule(schedule, timing, cwd) {
  try {
    const entry = await schedule.create({
      title: DIGEST_TITLE,
      prompt: DIGEST_PROMPT,
      timing,
      // new_once：第一次触发时创建一个会话，之后每次都投递到同一个会话，不重复开新的。
      target: { kind: 'new_once', create: cwd === undefined || cwd === '' ? {} : { cwd } },
    })
    const id = entry?.id ?? entry?.record?.id ?? ''
    if (typeof id !== 'string' || id === '') {
      return { supported: true, error: '计划任务创建了，但没拿到 id；到「设置 → 定时任务」里确认一下。' }
    }
    return { supported: true, scheduleId: id }
  } catch (error) {
    return { supported: true, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 关掉自动整理：删掉那条计划任务。
 * @param {object} ctx
 * @param {string} scheduleId
 */
export async function removeSchedule(ctx, scheduleId) {
  const schedule = scheduleService(ctx)
  if (schedule === undefined || typeof scheduleId !== 'string' || scheduleId === '') return { removed: false }
  try {
    await schedule.edit({ id: scheduleId, action: 'delete' })
    return { removed: true }
  } catch {
    return { removed: false }
  }
}

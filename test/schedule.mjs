// 自动整理测试：用一个假的 schedule 服务，验证「建任务 / 改周期 / 任务丢了重建 / 关闭时删任务」
// 以及 service.auto() 把结果写回状态。不真的建计划任务。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'

import { MailDigestService } from '../service.js'
import { DIGEST_TITLE, ensureSchedule, removeSchedule, timingFor } from '../schedule.js'
import { createStore } from '../store.js'

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-digest-schedule-'))

/** 记录所有调用的假 schedule 服务。 */
function fakeSchedule(options = {}) {
  const calls = { create: [], edit: [] }
  return {
    calls,
    service: {
      async create(request) {
        calls.create.push(request)
        if (options.createError !== undefined) throw new Error(options.createError)
        return { id: options.id ?? 'schedule-fake-1' }
      },
      async edit(request) {
        calls.edit.push(request)
        if (options.editError !== undefined) throw new Error(options.editError)
        if (options.notFound === true) return { id: request.id, code: 'schedule_not_found' }
        return { id: request.id }
      },
    },
  }
}

await check('第一次开启：用 every + new_once 建任务', async () => {
  const ctx = new Context()
  const fake = fakeSchedule({ id: 'schedule-fake-1' })
  ctx.provide('schedule', fake.service)
  const result = await ensureSchedule(ctx, { everySeconds: 7200 })
  assert.equal(result.supported, true)
  assert.equal(result.scheduleId, 'schedule-fake-1')
  const request = fake.calls.create[0]
  assert.equal(request.title, DIGEST_TITLE)
  assert.deepEqual(request.timing, { kind: 'every', every_seconds: 7200 })
  assert.equal(request.target.kind, 'new_once')
  assert.match(request.prompt, /mail_fetch/)
  assert.match(request.prompt, /mail_thread_summary/)
})

await check('周期会被夹到 1 小时 ~ 7 天', async () => {
  const ctx = new Context()
  const fake = fakeSchedule({})
  ctx.provide('schedule', fake.service)
  await ensureSchedule(ctx, { everySeconds: 5 })
  assert.equal(fake.calls.create[0].timing.every_seconds, 3600)
  await ensureSchedule(ctx, { everySeconds: 10_000_000 })
  assert.equal(fake.calls.create[1].timing.every_seconds, 604800)
})

await check('已经有任务：改周期而不是再建一个', async () => {
  const ctx = new Context()
  const fake = fakeSchedule({})
  ctx.provide('schedule', fake.service)
  const result = await ensureSchedule(ctx, { scheduleId: 'schedule-old', everySeconds: 43200 })
  assert.equal(result.scheduleId, 'schedule-old')
  assert.equal(fake.calls.create.length, 0)
  assert.equal(fake.calls.edit[0].action, 'update')
  assert.equal(fake.calls.edit[0].patch.timing.every_seconds, 43200)
})

await check('任务被用户删了：重新建一条', async () => {
  const ctx = new Context()
  const fake = fakeSchedule({ notFound: true, id: 'schedule-new' })
  ctx.provide('schedule', fake.service)
  const result = await ensureSchedule(ctx, { scheduleId: 'schedule-gone', everySeconds: 3600 })
  assert.equal(result.scheduleId, 'schedule-new')
  assert.equal(fake.calls.create.length, 1)
})

await check('建任务失败时把原因带回来', async () => {
  const ctx = new Context()
  const fake = fakeSchedule({ createError: '规则不合法' })
  ctx.provide('schedule', fake.service)
  const result = await ensureSchedule(ctx, { everySeconds: 3600 })
  assert.match(result.error, /规则不合法/)
})

await check('关闭时删任务', async () => {
  const ctx = new Context()
  const fake = fakeSchedule({})
  ctx.provide('schedule', fake.service)
  const result = await removeSchedule(ctx, 'schedule-x')
  assert.equal(result.removed, true)
  assert.deepEqual(fake.calls.edit[0], { id: 'schedule-x', action: 'delete' })
})

await check('没有 schedule 服务时给出可读的说明', async () => {
  const ctx = new Context()
  const result = await ensureSchedule(ctx, { everySeconds: 3600 })
  assert.equal(result.supported, false)
  assert.match(result.error, /计划任务/)
})

await check('service.auto 把 scheduleId 与周期写回状态', async () => {
  const ctx = new Context()
  const fake = fakeSchedule({ id: 'schedule-fake-9' })
  ctx.provide('schedule', fake.service)
  const service = new MailDigestService(ctx, { dir })
  const result = await service.auto({ enabled: true, everySeconds: 21600 })
  assert.equal(result.error, '')
  assert.equal(result.auto.enabled, true)
  assert.equal(result.auto.everySeconds, 21600)
  assert.equal(result.auto.scheduleId, 'schedule-fake-9')

  const store = createStore({ dir })
  const state = await store.readState()
  assert.equal(state.auto.enabled, true)
  assert.equal(state.auto.scheduleId, 'schedule-fake-9')
})

await check('再次开启沿用同一条任务；关闭则删掉并清 id', async () => {
  const ctx = new Context()
  const fake = fakeSchedule({})
  ctx.provide('schedule', fake.service)
  const service = new MailDigestService(ctx, { dir })
  const again = await service.auto({ enabled: true, everySeconds: 43200 })
  assert.equal(again.auto.scheduleId, 'schedule-fake-9')
  assert.equal(fake.calls.create.length, 0)
  assert.equal(fake.calls.edit[0].action, 'update')

  const off = await service.auto({ enabled: false })
  assert.equal(off.auto.enabled, false)
  assert.equal(off.auto.scheduleId, '')
  assert.equal(fake.calls.edit[1].action, 'delete')
})

await check('每天定时：把 HH:mm 变成 daily timing（带本机时区）', () => {
  const timing = timingFor({ mode: 'daily', at: '09:00' })
  assert.equal(timing.kind, 'daily')
  assert.equal(timing.daily.time, '09:00:00')
  assert.equal(typeof timing.daily.time_zone, 'string')
  assert.ok(timing.daily.time_zone.length > 0)
  // 非法时间退回 09:00
  assert.equal(timingFor({ mode: 'daily', at: '25:99' }).daily.time, '09:00:00')
})

await check('每隔 N 小时仍是 every timing，并被夹到 1 小时 ~ 7 天', () => {
  assert.deepEqual(timingFor({ mode: 'every', everySeconds: 7200 }), { kind: 'every', every_seconds: 7200 })
  assert.equal(timingFor({ mode: 'every', everySeconds: 5 }).every_seconds, 3600)
})

await check('service.auto 用 daily 模式建任务并记住 at', async () => {
  const ctx = new Context()
  const fake = fakeSchedule({ id: 'schedule-daily-1' })
  ctx.provide('schedule', fake.service)
  const service = new MailDigestService(ctx, { dir: join(dir, 'auto-daily') })
  const result = await service.auto({ enabled: true, mode: 'daily', at: '09:00' })
  assert.equal(result.error, '')
  assert.equal(result.auto.mode, 'daily')
  assert.equal(result.auto.at, '09:00')
  const request = fake.calls.create[0]
  assert.equal(request.timing.kind, 'daily')
  assert.equal(request.timing.daily.time, '09:00:00')
})

await check('手动整理：没有邮箱时直接报错', async () => {
  const ctx = new Context()
  ctx.provide('schedule', fakeSchedule({}).service)
  const service = new MailDigestService(ctx, { dir: join(dir, 'manual-empty') })
  await assert.rejects(() => service.runNow({}), /还没有邮箱/)
})

await check('手动整理：没有计划任务服务时给出可读提示', async () => {
  const ctx = new Context()
  const service = new MailDigestService(ctx, { dir: join(dir, 'manual-noservice') })
  await service.save({ account: { host: 'imap.qq.com', user: 'a@qq.com' } })
  await assert.rejects(() => service.runNow({}), /计划任务/)
})

await check('手动整理：几秒后投递一轮，没有自动任务时新建会话', async () => {
  const ctx = new Context()
  const fake = fakeSchedule({ id: 'schedule-manual-1' })
  ctx.provide('schedule', fake.service)
  const service = new MailDigestService(ctx, { dir: join(dir, 'manual-new') })
  await service.save({ account: { host: 'imap.qq.com', user: 'a@qq.com' } })
  const result = await service.runNow({})
  assert.equal(result.scheduled, true)
  assert.equal(result.accounts, 1)
  const request = fake.calls.create[0]
  assert.equal(request.title, '邮件整理（手动）')
  assert.equal(request.timing.kind, 'after')
  assert.equal(request.timing.after_seconds, 5)
  assert.equal(request.target.kind, 'new_once')
  assert.match(request.prompt, /mail_fetch/)
})

await check('手动整理：自动任务已有会话时投到同一个会话', async () => {
  const ctx = new Context()
  const fake = fakeSchedule({ id: 'schedule-manual-2' })
  // view 返回一个已经落地的会话目标
  fake.service.view = async (request) => ({
    id: request.id,
    target: { kind: 'session', sessionId: 'session-digest-1' }
  })
  ctx.provide('schedule', fake.service)
  const service = new MailDigestService(ctx, { dir: join(dir, 'manual-reuse') })
  await service.save({ account: { host: 'imap.qq.com', user: 'a@qq.com' } })
  await service.auto({ enabled: true, everySeconds: 3600 })
  const result = await service.runNow({})
  assert.equal(result.sessionId, 'session-digest-1')
  const manual = fake.calls.create.find((request) => request.title === '邮件整理（手动）')
  assert.deepEqual(manual.target, { kind: 'session', sessionId: 'session-digest-1' })
})

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1

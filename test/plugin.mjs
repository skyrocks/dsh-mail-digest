// 插件级测试：假 ctx + 真服务 + 临时目录，把九个工具的 execute 真跑一遍。
// 覆盖工具接线、参数校验、多账号参数；不连 IMAP、不依赖 DSH 进程。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'

import { MailDigestService } from '../service.js'
import { registerTools } from '../tools.js'
import { createStore, normalizeMessage } from '../store.js'

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

const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-digest-plugin-'))
const ctx = new Context()
const service = new MailDigestService(ctx, { dir })
const store = createStore({ dir })

const tools = new Map()
const fakeCtx = {
  tools: {
    register(definition) {
      assert.equal(typeof definition.name, 'string')
      assert.equal(tools.has(definition.name), false, `工具重名：${definition.name}`)
      tools.set(definition.name, definition)
    },
  },
  effect: () => {},
}
registerTools(fakeCtx, service)

const run = (name, args) => {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`没有工具 ${name}`)
  return tool.execute(args, undefined)
}

await check('注册了九个工具', () => {
  assert.deepEqual([...tools.keys()].sort(), [
    'mail_fetch', 'mail_file', 'mail_inbox', 'mail_read', 'mail_report',
    'mail_reports', 'mail_status', 'mail_thread', 'mail_thread_summary',
  ])
})

await check('每个工具都有参数 schema 和 render', () => {
  for (const [name, tool] of tools) {
    assert.equal(tool.parameters.type, 'object', `${name} parameters`)
    assert.equal(typeof tool.output.render, 'function', `${name} render`)
    assert.equal(typeof tool.execute, 'function', `${name} execute`)
  }
})

await check('mail_status 空状态提示去配置', async () => {
  const value = await run('mail_status', {})
  assert.equal(value.configured, false)
  assert.match(value.note, /还没有邮箱/)
  assert.match(value.note, /自动整理：关着/)
})

await check('没有账号时 mail_fetch 报错', async () => {
  await assert.rejects(() => run('mail_fetch', {}), /还没有邮箱/)
})

// 配两个账号（不存密码，测试里不需要真连 IMAP）。
await service.save({ account: { host: 'imap.qq.com', user: 'main@qq.com', name: '主邮箱' } })
await service.save({ account: { host: 'imap.163.com', user: 'work@163.com', name: '工作邮箱' } })
const status = await service.status()
const mainId = status.accounts.find((account) => account.user === 'main@qq.com').id
const workId = status.accounts.find((account) => account.user === 'work@163.com').id

await check('mail_status 列出两个账号与各自计数', async () => {
  const value = await run('mail_status', {})
  assert.match(value.note, /配了 2 个邮箱/)
  assert.match(value.note, new RegExp(mainId))
  assert.match(value.note, new RegExp(workId))
  assert.match(value.note, /主邮箱/)
})

await check('mail_inbox 空库时给下一步', async () => {
  const value = await run('mail_inbox', {})
  assert.deepEqual(value.messages, [])
  assert.match(value.note, /mail_fetch/)
})

// 两个账号各塞一封；主邮箱那封还有一个回复。
await store.writeMessages([
  normalizeMessage({
    id: `${mainId}:m1`, accountId: mainId, messageId: '<m1@x>', from: 'wang@x.com', fromName: '王五',
    subject: '报价单', date: '2026-01-02T09:00:00Z', text: '这是第一版报价，请确认。',
  }),
  normalizeMessage({
    id: `${mainId}:m2`, accountId: mainId, messageId: '<m2@x>', inReplyTo: '<m1@x>', from: 'zhao@x.com', fromName: '赵六',
    subject: 'Re: 报价单', date: '2026-01-05T09:00:00Z', text: '价格可以，但交期要提前两周。',
  }),
  normalizeMessage({
    id: `${workId}:w1`, accountId: workId, messageId: '<w1@x>', from: 'hr@corp.com', fromName: '人事',
    subject: '年度体检安排', date: '2026-01-06T09:00:00Z', text: '请在本周内预约体检。',
  }),
])
await service.reindex()

await check('mail_inbox 不传 accountId 时列全部并标账号', async () => {
  const value = await run('mail_inbox', {})
  assert.equal(value.messages.length, 3)
  assert.match(value.note, new RegExp(`\\(${mainId}\\)`))
  assert.match(value.note, new RegExp(`\\(${workId}\\)`))
  assert.match(value.note, /交期要提前/)
})

await check('mail_inbox 传 accountId 只看一个邮箱', async () => {
  const value = await run('mail_inbox', { accountId: workId })
  assert.equal(value.messages.length, 1)
  assert.equal(value.messages[0].accountId, workId)
  assert.match(value.note, /体检安排/)
})

await check('mail_read 读全文并给出线程总结位', async () => {
  const value = await run('mail_read', { id: `${mainId}:m1` })
  assert.match(value.note, /王五 <wang@x.com>/)
  assert.match(value.note, /第一版报价/)
  assert.match(value.note, /线程 t:/)
})

await check('mail_thread 给出整条时间轴并提示待总结', async () => {
  const inbox = await run('mail_inbox', { accountId: mainId })
  const key = inbox.messages[0].threadKey
  const value = await run('mail_thread', { key })
  assert.equal(value.messages.length, 2)
  assert.match(value.note, /总结需要更新/)
})

await check('参数校验：缺 id / 多余字段 / 类型不对', async () => {
  await assert.rejects(() => run('mail_read', {}), /缺少必填参数「id」/)
  await assert.rejects(() => run('mail_read', { id: 'x', extra: 1 }), /不认识的参数「extra」/)
  await assert.rejects(() => run('mail_inbox', { limit: 'many' }), /必须是数字/)
  await assert.rejects(() => run('mail_file', {}), /缺少必填参数「items」/)
  await assert.rejects(() => run('mail_report', {}), /缺少必填参数「accountId」/)
})

await check('mail_file 写回标签与摘要', async () => {
  const value = await run('mail_file', {
    items: [
      { id: `${mainId}:m1`, tags: ['项目协作', '报价'], priority: 'high', needsReply: true, summary: '确认报价' },
      { id: `${mainId}:m2`, tags: ['项目协作'], summary: '交期要提前两周' },
      { id: `${workId}:w1`, tags: ['个人事务'], summary: '本周内预约体检' },
    ],
  })
  assert.equal(value.total, 3)
  assert.match(value.note, /项目协作、报价/)
  assert.match(value.note, /优先级 高/)
})

await check('mail_thread_summary 写线程总结', async () => {
  const inbox = await run('mail_inbox', { accountId: mainId, status: 'filed' })
  const key = inbox.messages[0].threadKey
  const value = await run('mail_thread_summary', {
    key,
    summary: '报价第一版已发，对方接受价格但要求交期提前两周，待确认产能。',
  })
  assert.match(value.note, /已更新线程总结/)
})

await check('mail_report 按账号出报告（重点 + 摘要，不逐封罗列）', async () => {
  const main = await run('mail_report', {
    accountId: mainId,
    auto: true,
    overview: '报价在等交期确认。',
    focus: [{ title: '确认交期能否提前两周' }],
  })
  assert.match(main.id, /^r-\d{8}-\d{6}/)
  assert.match(main.markdown, /## 重点/)
  assert.match(main.markdown, /确认交期能否提前两周/)
  assert.match(main.markdown, /## 线程进展/)
  assert.match(main.markdown, /报价第一版已发/)
  assert.match(main.title, /主邮箱/)

  const work = await run('mail_report', { accountId: workId })
  assert.match(work.markdown, /体检安排/)
  assert.equal(work.markdown.includes('报价单'), false, '不能混进另一个邮箱')
})

await check('没有新整理结果时不生成空报告', async () => {
  const value = await run('mail_report', { accountId: mainId })
  assert.equal(value.id, '')
  assert.match(value.note, /没有新的整理结果/)
})

await check('mail_reports 列表按账号 / 读 / 删', async () => {
  const all = await run('mail_reports', { action: 'list' })
  assert.equal(all.reports.length, 2)

  const mine = await run('mail_reports', { action: 'list', accountId: workId })
  assert.equal(mine.reports.length, 1)
  assert.equal(mine.reports[0].accountId, workId)

  const opened = await run('mail_reports', { action: 'read', id: mine.reports[0].id })
  assert.match(opened.note, /# 邮件整理/)

  const removed = await run('mail_reports', { action: 'delete', id: mine.reports[0].id })
  assert.match(removed.note, /已删除报告/)
  assert.equal((await run('mail_reports', { action: 'list' })).reports.length, 1)
})

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1

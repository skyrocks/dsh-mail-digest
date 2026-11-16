// 服务层测试：真 cordis Context + 临时目录，把多账号的 status / save / removeAccount /
// file / list / read / thread / summarize / report / reports / auto 跑一遍。
// 不连 IMAP（只测没配账号、没密码的分支）。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'

import { MailDigestService } from '../service.js'
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

const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-digest-service-'))
const ctx = new Context()
const service = new MailDigestService(ctx, { dir })
const store = createStore({ dir })

await check('初始状态：没有账号、有默认标签、自动关着', async () => {
  const status = await service.status()
  assert.deepEqual(status.accounts, [])
  assert.equal(status.tags.length, 6)
  assert.equal(status.auto.enabled, false)
  assert.equal(status.counts.messages, 0)
  assert.equal(status.counts.reports, 0)
  assert.equal(status.dir, dir)
})

await check('没有账号时抓取直接报错', async () => {
  await assert.rejects(() => service.fetch({}), /还没有邮箱/)
})

await check('试连前先校验必填', async () => {
  const result = await service.probe({ account: {} })
  assert.equal(result.ok, false)
  assert.match(result.error, /先选服务商并填账号/)
})

await check('没有凭据库时存密码要报错，且账号没落盘', async () => {
  await assert.rejects(
    () => service.save({ account: { host: 'imap.qq.com', user: 'me@qq.com' }, password: 'secret' }),
    /凭据库/,
  )
  const state = await store.readState()
  assert.equal(state.accounts.length, 0)
})

await check('保存第一个账号：id 由邮箱生成', async () => {
  const status = await service.save({
    account: { host: 'imap.qq.com', user: 'me@qq.com', port: 993, secure: true, days: 14, limit: 20 },
    tags: [{ id: 'work', name: '工作' }, { id: '', name: '账单/发票' }],
  })
  assert.equal(status.accounts.length, 1)
  assert.equal(status.accounts[0].id, 'me')
  assert.equal(status.accounts[0].configured, true)
  assert.equal(status.accounts[0].counts.messages, 0)
  assert.deepEqual(status.tags.map((tag) => tag.name), ['工作', '账单/发票'])
})

await check('再加一个邮箱：两个账号、id 不撞', async () => {
  const status = await service.save({
    account: { host: 'imap.163.com', user: 'me@163.com', days: 7 },
  })
  assert.equal(status.accounts.length, 2)
  const ids = status.accounts.map((account) => account.id)
  assert.equal(new Set(ids).size, 2)
  assert.ok(ids.includes('me'))
  assert.ok(ids.includes('me-2'))
})

// 每个账号各两封，其中一封是同一线程的回复。
const accountA = 'me'
const accountB = 'me-2'
await store.writeMessages([
  normalizeMessage({
    id: 'a1', accountId: accountA, messageId: '<a1@x>', from: 'zhang@x.com', fromName: '张三',
    subject: '合同条款', date: '2026-01-01T09:00:00Z', text: '第一版合同，请确认付款条件。',
  }),
  normalizeMessage({
    id: 'a2', accountId: accountA, messageId: '<a2@x>', inReplyTo: '<a1@x>', from: 'li@x.com', fromName: '李四',
    subject: 'Re: 合同条款', date: '2026-01-03T09:00:00Z', text: '付款条件改成 30 天。',
  }),
  normalizeMessage({
    id: 'b1', accountId: accountB, messageId: '<b1@x>', from: 'noreply@shop.com', fromName: '购物站',
    subject: '本月账单', date: '2026-01-04T09:00:00Z', text: '您本月的账单已生成。',
  }),
])
await service.reindex()

await check('列表按账号隔离', async () => {
  const a = await service.list({ accountId: accountA })
  const b = await service.list({ accountId: accountB })
  const all = await service.list({})
  assert.equal(a.total, 2)
  assert.equal(b.total, 1)
  assert.equal(all.total, 3)
  assert.equal(a.messages.every((message) => message.accountId === accountA), true)
})

await check('线程按账号隔离：两个邮箱同主题也不合并', async () => {
  const a = await service.list({ accountId: accountA })
  const b = await service.list({ accountId: accountB })
  const keyA = a.messages[0].threadKey
  const keyB = b.messages[0].threadKey
  assert.match(keyA, new RegExp(`^t:${accountA}:`))
  assert.match(keyB, new RegExp(`^t:${accountB}:`))
  const threadB = await service.thread({ key: keyB })
  assert.equal(threadB.messages.length, 1)
})

await check('mail_thread 返回按时间正序的历史', async () => {
  const list = await service.list({ accountId: accountA })
  const key = list.messages.find((message) => message.id === 'a1').threadKey
  const result = await service.thread({ key })
  assert.equal(result.messages.length, 2)
  assert.equal(result.messages[0].id, 'a1')
  assert.equal(result.needsSummary, true)
})

await check('写回整理结果', async () => {
  const result = await service.file({
    items: [
      { id: 'a1', tags: ['工作', '合同'], priority: 'high', needsReply: true, summary: '确认付款条件' },
      { id: 'a2', tags: ['工作'], summary: '对方接受 30 天' },
      { id: 'b1', tags: ['账单/发票'], priority: 'low', summary: '月度账单' },
    ],
  })
  assert.equal(result.total, 3)
  const a = await service.list({ accountId: accountA, status: 'filed' })
  assert.equal(a.total, 2)
  assert.equal(a.messages.find((message) => message.id === 'a1').priority, 'high')
})

await check('写线程总结', async () => {
  const list = await service.list({ accountId: accountA })
  const key = list.messages.find((message) => message.id === 'a1').threadKey
  const result = await service.summarize({ key, summary: '合同付款条件改为 30 天，双方已同意。' })
  assert.equal(result.thread.count, 2)
  assert.equal((await service.thread({ key })).needsSummary, false)
})

await check('报告按账号生成：重点 + 摘要 + md/html/json 三份', async () => {
  const a = await service.report({
    accountId: accountA,
    overview: '合同进入收尾阶段。',
    focus: [{ title: '确认违约条款', detail: '对方周四给回复' }, { title: '付款条件已谈定 30 天' }],
  })
  assert.equal(a.empty, false)
  assert.match(a.path, /reports\/r-.+\.md$/)
  assert.match(a.htmlPath, /reports\/r-.+\.html$/)
  const markdown = readFileSync(a.path, 'utf8')
  assert.match(markdown, /## 重点/)
  assert.match(markdown, /确认违约条款/)
  assert.match(markdown, /## 线程进展/)
  assert.match(markdown, /付款条件改为 30 天/)
  assert.equal(markdown.includes('### 合同条款\n'), false, '不再逐封罗列')
  const html = readFileSync(a.htmlPath, 'utf8')
  assert.match(html, /<title>邮件整理/)
  assert.match(html, /确认违约条款/)
  assert.match(html, /<details>/)
  assert.match(readFileSync(a.path.replace(/\.md$/, '.json'), 'utf8'), /"focus"/)
  assert.match(a.title, /me@qq\.com/)

  const b = await service.report({ accountId: accountB })
  assert.equal(b.empty, false)
  assert.match(readFileSync(b.path, 'utf8'), /账单/)

  // 没新内容时不生成空报告
  assert.equal((await service.report({ accountId: accountA })).empty, true)
})

await check('缺 accountId 时不猜', async () => {
  await assert.rejects(() => service.report({}), /需要 accountId/)
})

await check('reportContent 返回结构化内容，旧报告退回原文', async () => {
  const list = await service.reports({ action: 'list' })
  const fresh = list.reports.find((report) => report.messages > 0)
  const { content } = await service.reportContent({ id: fresh.id })
  assert.equal(typeof content.title, 'string')
  assert.ok(Array.isArray(content.focus))
  await assert.rejects(() => service.reportContent({ id: 'nope' }), /读不出来/)
})

await check('openInBrowser 缺少 id 时报错', async () => {
  await assert.rejects(() => service.openInBrowser({}), /缺少 id/)
  await assert.rejects(() => service.openInBrowser({ id: 'nope' }), /没有 id 为/)
})

await check('报告列表按账号筛、未读、读一份、删除', async () => {
  const all = await service.reports({ action: 'list' })
  assert.equal(all.total, 2)
  const mine = await service.reports({ action: 'list', accountId: accountA })
  assert.equal(mine.total, 1)
  assert.equal(mine.unread, 1)

  const unread = await service.reports({ action: 'unread', accountId: accountA })
  assert.notEqual(unread.latest, null)
  const opened = await service.reports({ action: 'read', id: unread.latest.id })
  assert.match(opened.markdown, /## 重点|## 线程进展/)
  assert.equal((await service.reports({ action: 'unread', accountId: accountA })).unread, 0)

  const path = opened.report.path
  const deleted = await service.reports({ action: 'delete', id: unread.latest.id })
  assert.equal(deleted.removed, true)
  assert.equal(existsSync(path), false)
  assert.equal(existsSync(path.replace(/\.md$/, '.html')), false, '网页版也要删掉')
  assert.equal(existsSync(path.replace(/\.md$/, '.json')), false, '结构化内容也要删掉')
  assert.equal(deleted.restored, 2, '这批邮件退回待报告')
  // 退回后能重新出一份（标签/摘要还在，不用重新打）
  const again = await service.report({ accountId: accountA })
  assert.equal(again.empty, false)
  assert.match(readFileSync(again.path, 'utf8'), /合同条款/)
  assert.equal((await service.reports({ action: 'delete', id: again.id })).restored, 2)
})

await check('删账号：默认保留数据', async () => {
  const result = await service.removeAccount({ id: accountB })
  assert.equal(result.removed, true)
  assert.equal(result.messages, 0)
  const status = await service.status()
  assert.deepEqual(status.accounts.map((account) => account.id), [accountA])
  assert.equal(status.counts.messages, 3, '数据默认保留')
})

await check('删账号：deleteData 连邮件和报告一起清', async () => {
  // 重新加一个账号，造一封邮件和报告，再连数据一起删。
  await service.save({ account: { host: 'imap.126.com', user: 'temp@126.com' } })
  const state = await store.readState()
  const temp = state.accounts.find((account) => account.user === 'temp@126.com')
  const messages = await store.readMessages()
  await store.writeMessages([
    ...messages,
    normalizeMessage({
      id: `${temp.id}:t1`, accountId: temp.id, messageId: '<t1@x>', from: 'a@x.com',
      subject: '临时', date: '2026-02-01T09:00:00Z', text: '临时邮件',
    }),
  ])
  await service.reindex()
  await service.file({ items: [{ id: `${temp.id}:t1`, tags: ['工作'], summary: '临时' }] })
  const report = await service.report({ accountId: temp.id })
  assert.equal(report.empty, false)

  const result = await service.removeAccount({ id: temp.id, deleteData: true })
  assert.equal(result.removed, true)
  assert.equal(result.messages, 1)
  assert.equal(result.reports, 1)
  assert.equal(existsSync(report.path), false)
  assert.equal((await service.list({ accountId: temp.id })).total, 0)
})

await check('自动整理：没有 schedule 服务时报错但不抛', async () => {
  const result = await service.auto({ enabled: true, everySeconds: 7200 })
  assert.equal(result.auto.enabled, false)
  assert.match(result.error, /计划任务/)
  assert.equal(result.auto.everySeconds, 7200)
})

await check('非法枚举 / 不存在的 id 被拒', async () => {
  await assert.rejects(() => service.file({ items: [{ id: 'a1', priority: 'urgent' }] }), /priority 只能是/)
  await assert.rejects(() => service.file({ items: [{ id: 'nope' }] }), /没有 id 为/)
  await assert.rejects(() => service.summarize({ key: 't:none', summary: 'x' }), /没有 key 为/)
  await assert.rejects(() => service.reports({ action: 'wat' }), /不认识的 action/)
  await assert.rejects(() => service.report({ accountId: 'nope' }), /没有 id 为「nope」的账号/)
})

await check('一次保存多个中文新标签不会撞 id，允许清空', async () => {
  const otherDir = mkdtempSync(join(tmpdir(), 'dsh-mail-digest-tags-'))
  const other = new MailDigestService(new Context(), { dir: otherDir })
  const saved = await other.save({
    account: { host: 'imap.qq.com', user: 'a@qq.com' },
    tags: [{ name: '工作' }, { name: '账单/发票' }, { name: '工作' }],
  })
  const ids = saved.tags.map((tag) => tag.id)
  assert.equal(ids.length, 2)
  assert.equal(new Set(ids).size, 2)
  const emptied = await other.save({ account: saved.accounts[0], tags: [] })
  assert.deepEqual(emptied.tags, [])
  rmSync(otherDir, { recursive: true, force: true })
})

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1

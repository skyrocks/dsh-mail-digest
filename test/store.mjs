// 存储层测试：归一化、指纹、读写往返。不依赖 DSH，也不连网络。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_TAGS,
  createStore,
  messageKey,
  normalizeAccount,
  normalizeAuto,
  normalizeMessage,
  normalizeReport,
  normalizeTag,
  normalizeTags,
} from '../store.js'

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

const dir = mkdtempSync(join(tmpdir(), 'dsh-mail-digest-store-'))

await check('账号默认值', () => {
  const account = normalizeAccount({ host: 'imap.qq.com', user: 'me@qq.com' })
  assert.equal(account.port, 993)
  assert.equal(account.secure, true)
  assert.equal(account.mailbox, 'INBOX')
  assert.equal(account.days, 30)
  assert.equal(account.limit, 100)
})

await check('自动整理默认关、周期夹在 1 小时 ~ 7 天', () => {
  const auto = normalizeAuto({})
  assert.equal(auto.enabled, false)
  assert.equal(auto.everySeconds, DEFAULT_INTERVAL_SECONDS)
  assert.equal(normalizeAuto({ everySeconds: 10 }).everySeconds, 3600)
  assert.equal(normalizeAuto({ everySeconds: 99999999 }).everySeconds, 604800)
})

await check('标签 id 由名字生成、可按 id 复用', () => {
  assert.equal(normalizeTag({ name: 'Bills' }).id, 'bills')
  assert.equal(normalizeTag({ name: '账单', id: 'bill' }).id, 'bill')
  assert.throws(() => normalizeTag({ name: 'x', id: 'Bad Id' }), /不合法/)
  assert.throws(() => normalizeTag({ name: '' }), /缺少标签名称/)
  assert.throws(() => normalizeTag({ name: 'x'.repeat(30) }), /太长/)
})

await check('标签列表去重、去空、封顶 6 个', () => {
  assert.deepEqual(normalizeTags(['工作', '工作', '  ', '账单']), ['工作', '账单'])
  assert.equal(normalizeTags(['1', '2', '3', '4', '5', '6', '7', '8']).length, 6)
  assert.deepEqual(normalizeTags('nope'), [])
})

await check('指纹优先用 Message-ID', () => {
  const a = messageKey({ messageId: '<1@x>', from: 'a', subject: 's', date: 'd' })
  const b = messageKey({ messageId: '<1@x>', from: 'b', subject: 't', date: 'e' })
  assert.equal(a, b)
  assert.notEqual(a, messageKey({ from: 'a', subject: 's', date: 'd' }))
})

await check('邮件记录：截断、默认值、标签', () => {
  const message = normalizeMessage({
    from: 'a@b.com',
    subject: 's',
    date: '2026-01-01T00:00:00Z',
    text: 'x'.repeat(30000),
    tags: ['工作', '工作', '账单'],
  })
  assert.equal(message.text.includes('正文已截断'), true)
  assert.equal(message.status, 'new')
  assert.equal(message.priority, 'normal')
  assert.equal(message.needsReply, false)
  assert.deepEqual(message.tags, ['工作', '账单'])
})

await check('报告索引项归一化', () => {
  const report = normalizeReport({ id: 'r-1', messages: '3', threads: 2, unread: false })
  assert.equal(report.id, 'r-1')
  assert.equal(report.messages, 3)
  assert.equal(report.unread, false)
  assert.throws(() => normalizeReport({}), /缺 id/)
})

await check('多账号 / 标签 / 自动设置往返', async () => {
  const store = createStore({ dir })
  const state = await store.readState()
  assert.deepEqual(state.accounts, [])
  assert.equal(state.tags.length, DEFAULT_TAGS.length)

  await store.writeState({
    accounts: [
      { host: 'imap.163.com', user: 'me@163.com', days: 7 },
      { host: 'imap.qq.com', user: 'work@qq.com', name: '工作' },
    ],
    tags: [{ id: 'work', name: '工作' }],
    auto: { enabled: true, everySeconds: 7200, scheduleId: 's-1' },
  })
  const again = await store.readState()
  assert.equal(again.accounts.length, 2)
  assert.equal(again.accounts[0].host, 'imap.163.com')
  assert.equal(again.accounts[0].days, 7)
  assert.equal(again.accounts[0].id, 'me')
  assert.equal(again.accounts[1].id, 'work')
  assert.equal(again.accounts[1].name, '工作')
  assert.deepEqual(again.tags, [{ id: 'work', name: '工作' }])
  assert.equal(again.auto.enabled, true)
  assert.equal(again.auto.scheduleId, 's-1')
})

await check('旧版单账号文件读出来自动迁移成数组', async () => {
  const legacyDir = join(dir, 'legacy')
  const legacy = createStore({ dir: legacyDir })
  await legacy.writeJson
  await legacy.writeState({ accounts: [{ host: 'imap.gmail.com', user: 'old@gmail.com' }], tags: [], auto: {} })
  // 手工把文件改成 v1 形状，再读回来
  const { writeFile, readFile } = await import('node:fs/promises')
  const path = join(legacyDir, 'account.json')
  const body = JSON.parse(await readFile(path, 'utf8'))
  await writeFile(path, JSON.stringify({ version: 1, account: body.accounts[0], tags: [], auto: {} }))
  const migrated = await legacy.readState()
  assert.equal(migrated.accounts.length, 1)
  assert.equal(migrated.accounts[0].host, 'imap.gmail.com')
  assert.equal(migrated.version, 2)
})

await check('邮件/线程/报告往返，空文件当空集合', async () => {
  const store = createStore({ dir: join(dir, 'nested') })
  assert.deepEqual(await store.readMessages(), [])
  assert.deepEqual(await store.readThreads(), {})
  assert.deepEqual(await store.readReports(), [])

  const message = normalizeMessage({ id: 'm1', from: 'a@b', subject: '你好', date: '2026-01-02', text: '正文' })
  await store.writeMessages([message])
  await store.writeThreads({ 't:1': { key: 't:1', subject: '你好', count: 1, messageIds: ['m1'] } })
  await store.writeReports([{ id: 'r-1', title: '报告', path: '/tmp/x.md' }])

  assert.equal((await store.readMessages())[0].subject, '你好')
  assert.equal((await store.readThreads())['t:1'].count, 1)
  assert.equal((await store.readReports())[0].title, '报告')
})

rmSync(dir, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1

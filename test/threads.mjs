// 线程归并测试：邮件头连线、同主题回退、总结接续。
import assert from 'node:assert/strict'

import { buildThreads, carrySummaries, subjectKey } from '../threads.js'
import { normalizeMessage } from '../store.js'

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

function mail(overrides) {
  return normalizeMessage({
    from: 'a@x.com',
    subject: '合同',
    date: '2026-01-01T00:00:00Z',
    text: 'body',
    ...overrides,
  })
}

await check('去掉 Re/Fwd/回复 前缀', () => {
  assert.equal(subjectKey('Re: 合同'), '合同')
  assert.equal(subjectKey('RE: Fwd: Re: 合同'), '合同')
  assert.equal(subjectKey('转发：回复: 合同'), '合同')
  assert.equal(subjectKey('  合同  '), '合同')
  assert.equal(subjectKey('No prefix'), 'no prefix')
})

await check('In-Reply-To 把两封连成一条线', () => {
  const first = mail({ id: 'm1', messageId: '<a@x>', date: '2026-01-01T00:00:00Z' })
  const reply = mail({ id: 'm2', messageId: '<b@x>', inReplyTo: '<a@x>', date: '2026-01-02T00:00:00Z' })
  const { threads, byMessage } = buildThreads([first, reply])
  assert.equal(threads.length, 1)
  assert.equal(threads[0].count, 2)
  assert.equal(threads[0].firstAt, '2026-01-01T00:00:00Z')
  assert.equal(threads[0].lastAt, '2026-01-02T00:00:00Z')
  assert.equal(byMessage.get('m1'), byMessage.get('m2'))
})

await check('References 里缺中间那封也能归到一起', () => {
  const one = mail({ id: 'm1', messageId: '<a@x>', subject: 'Re: 合同', date: '2026-01-01T00:00:00Z' })
  const two = mail({ id: 'm2', messageId: '<c@x>', references: ['<root@x>', '<a@x>'], date: '2026-01-02T00:00:00Z' })
  const three = mail({ id: 'm3', messageId: '<d@x>', references: ['<root@x>'], date: '2026-01-03T00:00:00Z' })
  const { threads } = buildThreads([one, two, three])
  assert.equal(threads.length, 1)
  assert.equal(threads[0].count, 3)
})

await check('没有邮件头：同主题 + 同联系人 才合并', () => {
  const a = mail({ id: 'm1', from: 'zhang@x.com', subject: '发票', date: '2026-01-01T00:00:00Z' })
  const b = mail({ id: 'm2', from: 'zhang@x.com', subject: 'Re: 发票', date: '2026-01-02T00:00:00Z' })
  const c = mail({ id: 'm3', from: 'someone@y.com', subject: 'Re: 发票', date: '2026-01-03T00:00:00Z' })
  const { threads } = buildThreads([a, b, c])
  assert.equal(threads.length, 2)
  const merged = threads.find((thread) => thread.count === 2)
  assert.notEqual(merged, undefined)
})

await check('不同主题不合并', () => {
  const a = mail({ id: 'm1', subject: '合同', date: '2026-01-01T00:00:00Z' })
  const b = mail({ id: 'm2', subject: '报销', date: '2026-01-02T00:00:00Z' })
  assert.equal(buildThreads([a, b]).threads.length, 2)
})

await check('线程 key 稳定：同一批邮件重复计算得到同样的 key', () => {
  const mails = [
    mail({ id: 'm1', messageId: '<a@x>', date: '2026-01-01T00:00:00Z' }),
    mail({ id: 'm2', messageId: '<b@x>', inReplyTo: '<a@x>', date: '2026-01-02T00:00:00Z' }),
  ]
  const first = buildThreads(mails).threads[0].key
  const second = buildThreads([...mails].reverse()).threads[0].key
  assert.equal(first, second)
})

await check('参与人按发件人去重、最多 8 个', () => {
  const mails = Array.from({ length: 12 }, (_item, index) => mail({
    id: `m${index}`,
    messageId: `<m${index}@x>`,
    inReplyTo: index === 0 ? undefined : '<m0@x>',
    from: `p${index}@x.com`,
    fromName: `P${index}`,
  }))
  const { threads } = buildThreads(mails)
  assert.equal(threads.length, 1)
  assert.equal(threads[0].participants.length, 8)
})

await check('总结能按 key 接续', () => {
  const mails = [mail({ id: 'm1', messageId: '<a@x>' })]
  const threads = buildThreads(mails).threads
  const previous = {
    [threads[0].key]: {
      key: threads[0].key,
      subjectKey: threads[0].subjectKey,
      participants: threads[0].participants,
      summary: '已经谈好价格',
      summarizedAt: '2026-01-05T00:00:00Z',
      summaryCount: 1,
    },
  }
  const merged = carrySummaries(previous, buildThreads([...mails, mail({ id: 'm2', messageId: '<b@x>', inReplyTo: '<a@x>', date: '2026-01-06T00:00:00Z' })]).threads)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].summary, '已经谈好价格')
  assert.equal(merged[0].count, 2)
  assert.equal(merged[0].summaryCount, 1)
})

await check('key 变了也能按主题+联系人接上老总结', () => {
  const older = [mail({ id: 'm1', from: 'zhang@x.com', subject: '发票', messageId: '<a@x>' })]
  const previous = {
    't:old': {
      key: 't:old',
      subjectKey: '发票',
      participants: ['Zhang'],
      summary: '上个月的发票已开',
      summarizedAt: '2026-01-05T00:00:00Z',
      summaryCount: 1,
    },
  }
  const merged = carrySummaries(previous, buildThreads(older).threads)
  assert.equal(merged[0].summary, '上个月的发票已开')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1

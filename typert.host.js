// Typert Host 清单：声明 mailDigest/* 的 direct 调用。
// 0.2.x 的 strict codec 必须是 `{ mode, typeSymbol, create() }`；这里不依赖 zod。
// Client 侧 client.js 有一份形状相同的声明。
//
// 注意：密码永远不在参数里回传——save/probe 只接受「新密码」，status 只回 hasPassword。

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function fail(field, expected) {
  throw new Error(`dsh-mail-digest ${field}: 需要 ${expected}`)
}

function string(field, value, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return value
  if (typeof value !== 'string') fail(field, '字符串')
  return value
}

function codec(typeSymbol, parse) {
  return { mode: 'strict', typeSymbol, create: () => ({ parse }) }
}

const result = (name, parse) => codec(`@skyrocks/dsh-mail-digest#MailDigest${name}Result`, parse)
const parameter = (name, parse) => ({
  name,
  wire: name,
  source: 'json',
  codec: codec(`@skyrocks/dsh-mail-digest#${name}`, parse),
})

const record = (value) => {
  if (!isRecord(value)) fail('result', '对象')
  return value
}

const parseStatus = (value) => {
  record(value)
  if (!Array.isArray(value.accounts)) fail('result.accounts', '数组')
  if (!Array.isArray(value.tags)) fail('result.tags', '数组')
  if (!isRecord(value.auto)) fail('result.auto', '对象')
  if (!isRecord(value.counts)) fail('result.counts', '对象')
  return value
}

const parseProbe = (value) => {
  record(value)
  if (typeof value.ok !== 'boolean') fail('result.ok', '布尔值')
  return value
}

const parseFetch = (value) => {
  record(value)
  if (typeof value.added !== 'number') fail('result.added', '数字')
  return value
}

const parseList = (value) => {
  record(value)
  if (!Array.isArray(value.messages)) fail('result.messages', '数组')
  return value
}

const parseRead = (value) => {
  record(value)
  if (!isRecord(value.message)) fail('result.message', '对象')
  return value
}

const parseThread = (value) => {
  record(value)
  if (!isRecord(value.thread)) fail('result.thread', '对象')
  if (!Array.isArray(value.messages)) fail('result.messages', '数组')
  return value
}

const parseFile = (value) => {
  record(value)
  if (!Array.isArray(value.messages)) fail('result.messages', '数组')
  return value
}

const parseSummarize = (value) => {
  record(value)
  if (!isRecord(value.thread)) fail('result.thread', '对象')
  return value
}

const parseReport = (value) => {
  record(value)
  string('result.path', value.path)
  string('result.markdown', value.markdown)
  return value
}

const parseReports = (value) => {
  record(value)
  if (!Array.isArray(value.reports)) fail('result.reports', '数组')
  return value
}

const parseAuto = (value) => {
  record(value)
  if (!isRecord(value.auto)) fail('result.auto', '对象')
  if (typeof value.error !== 'string') fail('result.error', '字符串')
  return value
}

const parseSaveRequest = (value) => {
  if (!isRecord(value)) fail('save request', '对象')
  if (value.account !== undefined && !isRecord(value.account)) fail('save request.account', '对象')
  if (value.tags !== undefined && !Array.isArray(value.tags)) fail('save request.tags', '数组')
  if (value.password !== undefined) string('save request.password', value.password)
  return value
}

const parseRemoveAccountRequest = (value) => {
  if (!isRecord(value)) fail('removeAccount request', '对象')
  string('removeAccount request.id', value.id)
  return value
}

const parseProbeRequest = (value) => {
  if (!isRecord(value)) fail('probe request', '对象')
  if (value.account !== undefined && !isRecord(value.account)) fail('probe request.account', '对象')
  if (value.password !== undefined) string('probe request.password', value.password)
  return value
}

const parseIdRequest = (value) => {
  if (!isRecord(value)) fail('request', '对象')
  string('request.id', value.id)
  return value
}

const parseItemsRequest = (value) => {
  if (!isRecord(value)) fail('request', '对象')
  if (!Array.isArray(value.items)) fail('request.items', '数组')
  return value
}

const parseThreadRequest = (value) => {
  if (!isRecord(value)) fail('request', '对象')
  if (value.key !== undefined) string('request.key', value.key)
  if (value.id !== undefined) string('request.id', value.id)
  return value
}

const parseSummarizeRequest = (value) => {
  if (!isRecord(value)) fail('request', '对象')
  string('request.key', value.key)
  string('request.summary', value.summary)
  return value
}

const parseAutoRequest = (value) => {
  if (!isRecord(value)) fail('request', '对象')
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') fail('request.enabled', '布尔值')
  if (value.mode !== undefined && value.mode !== 'every' && value.mode !== 'daily') fail('request.mode', 'every 或 daily')
  if (value.at !== undefined) string('request.at', value.at)
  if (value.cwd !== undefined) string('request.cwd', value.cwd)
  return value
}

const invocation = (method, parameters, parseResult) => ({
  id: `@skyrocks/dsh-mail-digest#mailDigest/${method}`,
  service: 'mailDigest',
  namespace: 'mailDigest',
  method,
  invocation: { kind: 'direct' },
  parameters,
  result: result(`${method[0].toUpperCase()}${method.slice(1)}`, parseResult),
})

const request = (parse) => [parameter('request', parse)]

export const TYPERT = {
  package: '@skyrocks/dsh-mail-digest',
  face: 'host',
  schemas: [],
  invocations: [
    invocation('status', [], parseStatus),
    invocation('save', request(parseSaveRequest), parseStatus),
    invocation('removeAccount', request(parseRemoveAccountRequest), (value) => {
      record(value)
      if (typeof value.removed !== 'boolean') fail('result.removed', '布尔值')
      return value
    }),
    invocation('probe', request(parseProbeRequest), parseProbe),
    invocation('fetch', request((value) => record(value)), parseFetch),
    invocation('list', request((value) => record(value)), parseList),
    invocation('read', request(parseIdRequest), parseRead),
    invocation('thread', request(parseThreadRequest), parseThread),
    invocation('file', request(parseItemsRequest), parseFile),
    invocation('summarize', request(parseSummarizeRequest), parseSummarize),
    invocation('report', request((value) => record(value)), parseReport),
    invocation('reports', request((value) => record(value)), parseReports),
    invocation('auto', request(parseAutoRequest), parseAuto),
    invocation('reportContent', request(parseIdRequest), (value) => {
      record(value)
      if (!isRecord(value.content)) fail('result.content', '对象')
      if (value.html !== undefined) string('result.html', value.html)
      return value
    }),
    invocation('openInBrowser', request(parseIdRequest), (value) => {
      record(value)
      if (value.ok !== true) fail('result.ok', 'true')
      return value
    }),
    invocation('runNow', request((value) => record(value)), (value) => {
      record(value)
      if (typeof value.scheduled !== 'boolean') fail('result.scheduled', '布尔值')
      string('result.note', value.note)
      return value
    }),
  ],
  model: { services: [], events: [], objects: [] },
}

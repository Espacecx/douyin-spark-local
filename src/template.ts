import type { FriendRecord } from './types.js'

const TOKEN_PATTERN = /\{\{\s*([a-zA-Z]+)\s*\}\}/g
const ALLOWED_TOKENS = new Set(['friend', 'date', 'time', 'weekday'])

export function renderMessage(template: string, friend: FriendRecord, now = new Date()): string {
  const unknown = [...template.matchAll(TOKEN_PATTERN)]
    .map((match) => match[1] ?? '')
    .filter((token) => !ALLOWED_TOKENS.has(token))

  if (unknown.length > 0) {
    throw new Error(`未知模板变量：${[...new Set(unknown)].join('、')}`)
  }

  const date = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .replaceAll('/', '-')

  const time = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now)

  const weekday = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'long',
  }).format(now)

  const values: Record<string, string> = {
    friend: friend.name,
    date,
    time,
    weekday,
  }

  const rendered = template.replace(TOKEN_PATTERN, (_whole, token: string) => values[token] ?? '').trim()
  if (!rendered) {
    throw new Error('消息模板渲染后为空')
  }
  if (rendered.length > 500) {
    throw new Error('消息长度超过 500 个字符')
  }
  return rendered
}

export function localDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

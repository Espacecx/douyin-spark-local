import { createReadStream, existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'

import { AppDatabase } from './db.js'
import { resolveAppPaths } from './paths.js'
import { PlaywrightDouyinClient } from './browser/playwright-client.js'
import { LocalScheduler } from './services/scheduler.js'
import { TaskRunner } from './services/task-runner.js'
import { renderMessage } from './template.js'
import type { AppSettings, BrowserChannel, RunMode } from './types.js'

const HOST = '127.0.0.1'
const PORT = Number(process.env.DOUYIN_SPARK_PORT ?? 4317)
const RISK_PHRASE = '我理解账号风险'
const PUBLIC_DIR = join(process.cwd(), 'public')
const paths = resolveAppPaths(process.env.DOUYIN_SPARK_DATA_DIR)
const db = new AppDatabase(paths.databasePath)
const client = new PlaywrightDouyinClient(paths.browserProfileDir, () => db.getSettings())
const runner = new TaskRunner(db, client)
const scheduler = new LocalScheduler(() => db.getSettings(), () => runner.run('scheduled'))
scheduler.start()

class HttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const server = createServer(async (request, response) => {
  try {
    await route(request, response)
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    const message = error instanceof Error ? error.message : String(error)
    sendJson(response, status, { ok: false, error: message })
  }
})

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = request.method ?? 'GET'
  const url = new URL(request.url ?? '/', `http://${HOST}:${PORT}`)

  if (method === 'GET' && url.pathname === '/api/status') {
    sendJson(response, 200, {
      ok: true,
      processId: process.pid,
      browser: await client.status(),
      runner: runner.snapshot(),
      scheduler: scheduler.snapshot(),
      settings: publicSettings(db.getSettings()),
      friendCount: db.listFriends().length,
      selectedCount: db.listFriends().filter((friend) => friend.selected).length,
    })
    return
  }

  if (method === 'POST' && url.pathname === '/api/browser/login') {
    sendJson(response, 200, { ok: true, browser: await client.openLogin() })
    return
  }

  if (method === 'POST' && url.pathname === '/api/browser/close') {
    await client.close()
    sendJson(response, 200, { ok: true })
    return
  }

  if (method === 'POST' && url.pathname === '/api/probe') {
    const result = await runner.probe()
    sendJson(response, 200, { ok: true, ...result, storedFriends: db.listFriends() })
    return
  }

  if (method === 'GET' && url.pathname === '/api/friends') {
    sendJson(response, 200, { ok: true, friends: db.listFriends() })
    return
  }

  if (method === 'PUT' && url.pathname === '/api/friends/selection') {
    const body = await readJson(request)
    if (!Array.isArray(body.selectedIds) || body.selectedIds.some((id) => typeof id !== 'string')) {
      throw new HttpError(400, 'selectedIds 必须是字符串数组')
    }
    sendJson(response, 200, { ok: true, friends: db.setSelectedFriends(body.selectedIds as string[]) })
    return
  }

  if (method === 'GET' && url.pathname === '/api/settings') {
    sendJson(response, 200, { ok: true, settings: publicSettings(db.getSettings()) })
    return
  }

  if (method === 'PUT' && url.pathname === '/api/settings') {
    const body = await readJson(request)
    const settings = validateSettingsPatch(db.getSettings(), body)
    db.saveSettings(settings)
    sendJson(response, 200, { ok: true, settings: publicSettings(settings) })
    return
  }

  if (method === 'POST' && url.pathname === '/api/run/preview') {
    sendJson(response, 200, { ok: true, run: await runner.run('preview') })
    return
  }

  if (method === 'POST' && url.pathname === '/api/run/identity-check') {
    sendJson(response, 200, { ok: true, results: await runner.checkSelectedIdentities() })
    return
  }

  if (method === 'POST' && url.pathname === '/api/run/execute') {
    sendJson(response, 200, { ok: true, run: await runner.run('manual') })
    return
  }

  if (method === 'POST' && url.pathname === '/api/run/stop') {
    sendJson(response, 200, { ok: true, stopped: runner.stop() })
    return
  }

  if (method === 'GET' && url.pathname === '/api/runs') {
    sendJson(response, 200, { ok: true, runs: db.listRuns(25) })
    return
  }

  if (method === 'GET') {
    serveStatic(url.pathname, response)
    return
  }

  throw new HttpError(404, '未找到该功能')
}

function validateSettingsPatch(current: AppSettings, input: Record<string, unknown>): AppSettings {
  const browserChannel = input.browserChannel ?? current.browserChannel
  const messageTemplate = input.messageTemplate ?? current.messageTemplate
  const scheduleEnabled = input.scheduleEnabled ?? current.scheduleEnabled
  const scheduleTime = input.scheduleTime ?? current.scheduleTime
  const sendingEnabled = input.sendingEnabled ?? current.sendingEnabled
  const maxTargetsPerRun = input.maxTargetsPerRun ?? current.maxTargetsPerRun
  const verificationTimeoutMs = input.verificationTimeoutMs ?? current.verificationTimeoutMs

  if (browserChannel !== 'msedge' && browserChannel !== 'chrome') {
    throw new HttpError(400, '浏览器只能选择 Edge 或 Chrome')
  }
  if (typeof messageTemplate !== 'string') throw new HttpError(400, '消息模板格式错误')
  if (typeof scheduleEnabled !== 'boolean' || typeof sendingEnabled !== 'boolean') {
    throw new HttpError(400, '开关值格式错误')
  }
  if (typeof scheduleTime !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) {
    throw new HttpError(400, '定时时间格式应为 HH:MM')
  }
  if (typeof maxTargetsPerRun !== 'number' || !Number.isInteger(maxTargetsPerRun) || maxTargetsPerRun < 1 || maxTargetsPerRun > 50) {
    throw new HttpError(400, '单次好友数量必须是 1–50 的整数')
  }
  if (
    typeof verificationTimeoutMs !== 'number' ||
    !Number.isInteger(verificationTimeoutMs) ||
    verificationTimeoutMs < 5_000 ||
    verificationTimeoutMs > 30_000
  ) {
    throw new HttpError(400, '发送校验时间必须在 5–30 秒之间')
  }

  let riskAcknowledged = current.riskAcknowledged
  if (sendingEnabled && !current.sendingEnabled && !riskAcknowledged) {
    if (input.riskAcknowledgement !== RISK_PHRASE) {
      throw new HttpError(400, `首次开启实际发送时，请输入“${RISK_PHRASE}”`)
    }
    riskAcknowledged = true
  }

  const next: AppSettings = {
    browserChannel: browserChannel as BrowserChannel,
    messageTemplate,
    scheduleEnabled,
    scheduleTime,
    sendingEnabled,
    riskAcknowledged,
    maxTargetsPerRun,
    verificationTimeoutMs,
  }

  renderMessage(next.messageTemplate, {
    id: 'validation',
    name: '测试好友',
    avatar: '',
    sparkText: '',
    selected: false,
    lastSeenAt: new Date().toISOString(),
  })
  return next
}

function publicSettings(settings: AppSettings): AppSettings {
  return { ...settings }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of request) {
    raw += String(chunk)
    if (raw.length > 64_000) throw new HttpError(413, '请求内容过大')
  }
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object')
    return parsed as Record<string, unknown>
  } catch {
    throw new HttpError(400, '请求不是有效的 JSON')
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

function serveStatic(pathname: string, response: ServerResponse): void {
  const requested = pathname === '/' ? '/index.html' : pathname
  const safePath = normalize(requested).replace(/^(?:\.\.[/\\])+/, '')
  const filePath = join(PUBLIC_DIR, safePath)
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) throw new HttpError(404, '页面不存在')

  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
  }
  response.writeHead(200, {
    'Content-Type': types[extname(filePath)] ?? 'application/octet-stream',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
  })
  createReadStream(filePath).pipe(response)
}

server.listen(PORT, HOST, () => {
  console.log(`抖音续火助手已启动：http://${HOST}:${PORT}`)
  console.log(`数据仅保存在本机：${paths.dataDir}`)
})

async function shutdown(): Promise<void> {
  scheduler.stop()
  runner.stop()
  await client.close()
  db.close()
  server.close()
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

export { RISK_PHRASE, validateSettingsPatch }

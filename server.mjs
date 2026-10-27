#!/usr/bin/env node
// 本地 Anthropic Messages API 代理：把 Claude Code 的请求转给 WorkBuddy。
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { collectMessage, estimateTokens, toOpenAIChat, translateStream } from './lib/anthropic.mjs'
import { VARIANT, config, debugLog, log } from './lib/config.mjs'
import { credentialStatus, resolveCredential } from './lib/credential.mjs'
import { registerService, STOP_PATH, stopService, unregisterService } from './lib/service.mjs'
import { UpstreamError, chatStream, ensureCatalog, knownModelIds } from './lib/upstream.mjs'

const BODY_LIMIT = 64 * 1024 * 1024
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hostnameOf(host) {
  let value = String(host ?? '')
    .trim()
    .toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? value : value.slice(0, end + 1)
  }
  const colon = value.lastIndexOf(':')
  if (
    colon !== -1 &&
    !value.slice(0, colon).includes(':') &&
    /^\d+$/u.test(value.slice(colon + 1))
  ) {
    value = value.slice(0, colon)
  }
  return value
}

function hostAllowed(host) {
  return LOOPBACK_HOSTS.has(hostnameOf(host))
}

function originAllowed(origin) {
  if (typeof origin !== 'string' || origin.trim() === '') return true
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname)
  } catch {
    return false
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function authorized(req) {
  if (config.proxyToken === '') return true
  const candidates = []
  const header = req.headers.authorization
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/iu.exec(header.trim())
    if (match !== null) candidates.push(match[1].trim())
  }
  const apiKey = req.headers['x-api-key']
  if (typeof apiKey === 'string') candidates.push(apiKey.trim())
  return candidates.some((candidate) => safeEqual(candidate, config.proxyToken))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Anthropic 错误体；Claude Code 会按 type 和 HTTP 状态展示/重试。 */
function sendError(res, status, type, message) {
  sendJson(res, status, { type: 'error', error: { type, message } })
}

function statusForKind(kind) {
  switch (kind) {
    case 'session_dead':
      return 401
    case 'soft_rate':
      return 429
    case 'not_found':
      return 404
    case 'server':
      return 502
    default:
      return 400
  }
}

function errorTypeForKind(kind) {
  switch (kind) {
    case 'session_dead':
      return 'authentication_error'
    case 'soft_rate':
      return 'rate_limit_error'
    case 'not_found':
      return 'not_found_error'
    case 'server':
      return 'api_error'
    default:
      return 'invalid_request_error'
  }
}

function upstreamErrorMessage(error) {
  if (error instanceof UpstreamError && error.kind === 'session_dead') {
    return `${error.message}（请打开 WorkBuddy App 重新登录）`
  }
  return error.message
}

/** 请求模型不是 WorkBuddy id 时（例如 Claude 别名）映射到兜底模型。 */
function resolveUpstreamModel(requested, catalog) {
  const ids = new Set(catalog.map((model) => model.id))
  const normalized = typeof requested === 'string' ? requested.replace(/\[1m\]$/iu, '').trim() : ''
  if (normalized !== '' && ids.has(normalized)) return normalized
  const fallback = ids.has(config.defaultModel) ? config.defaultModel : catalog[0]?.id
  if (fallback !== undefined) {
    if (normalized !== '') debugLog('模型映射:', normalized, '→', fallback)
    return fallback
  }
  return normalized !== '' ? normalized : config.defaultModel
}

async function handleMessages(req, res) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch (error) {
    sendError(res, 400, 'invalid_request_error', `请求体不是合法 JSON：${String(error)}`)
    return
  }
  if (!isObject(body)) {
    sendError(res, 400, 'invalid_request_error', '请求体必须是 JSON 对象')
    return
  }

  let credential
  try {
    credential = await resolveCredential()
  } catch (error) {
    sendError(res, 401, 'authentication_error', String(error))
    return
  }

  const catalog = await ensureCatalog(credential)
  const upstreamModel = resolveUpstreamModel(body.model, catalog)
  let openai
  try {
    openai = toOpenAIChat(body, upstreamModel)
  } catch (error) {
    sendError(res, 400, 'invalid_request_error', String(error))
    return
  }

  const inputTokens = estimateTokens({
    system: body.system,
    messages: body.messages,
    tools: body.tools,
  })
  log(
    `→ ${String(body.model ?? '(none)')} → ${upstreamModel}` +
      ` (${Array.isArray(body.messages) ? body.messages.length : 0} 条消息, ` +
      `${Array.isArray(body.tools) ? body.tools.length : 0} 个工具)`,
  )

  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })
  const timeout =
    Number.isFinite(config.requestTimeoutMs) && config.requestTimeoutMs > 0
      ? AbortSignal.timeout(config.requestTimeoutMs)
      : undefined
  const signal =
    timeout === undefined ? controller.signal : AbortSignal.any([controller.signal, timeout])

  let upstream
  try {
    upstream = await chatStream(credential, openai, signal)
  } catch (error) {
    const kind = error instanceof UpstreamError ? error.kind : 'server'
    sendError(res, statusForKind(kind), errorTypeForKind(kind), upstreamErrorMessage(error))
    return
  }

  if (body.stream === false) {
    try {
      const message = await collectMessage(upstream.body, {
        model: upstreamModel,
        inputTokens,
        emit: () => {},
      })
      sendJson(res, 200, message)
    } catch (error) {
      sendError(res, 502, 'api_error', `上游流解析失败：${String(error)}`)
    }
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const emit = (event, data) => {
    if (res.writableEnded || res.destroyed) return
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  try {
    await translateStream(upstream.body, { model: upstreamModel, inputTokens, emit })
  } catch (error) {
    const kind = error instanceof UpstreamError ? error.kind : 'server'
    emit('error', {
      type: 'error',
      error: { type: errorTypeForKind(kind), message: upstreamErrorMessage(error) },
    })
    debugLog('流式响应失败:', String(error))
  } finally {
    res.end()
  }
}

async function handleCountTokens(req, res) {
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch (error) {
    sendError(res, 400, 'invalid_request_error', `请求体不是合法 JSON：${String(error)}`)
    return
  }
  const tokens = estimateTokens({
    system: body?.system,
    messages: body?.messages,
    tools: body?.tools,
  })
  sendJson(res, 200, { input_tokens: tokens })
}

async function handleModels(req, res, pathname) {
  let catalog = []
  try {
    const credential = await resolveCredential()
    catalog = await ensureCatalog(credential)
  } catch (error) {
    debugLog('模型列表获取失败:', String(error))
  }
  if (catalog.length === 0) {
    catalog = [{ id: config.defaultModel, name: config.defaultModel }]
  }
  const requestedId = pathname.startsWith('/v1/models/')
    ? decodeURIComponent(pathname.slice('/v1/models/'.length))
    : undefined
  if (requestedId !== undefined) {
    const model = catalog.find((entry) => entry.id === requestedId)
    if (model === undefined) {
      sendError(res, 404, 'not_found_error', `没有模型 ${requestedId}`)
      return
    }
    sendJson(res, 200, {
      type: 'model',
      id: model.id,
      display_name: model.name,
      created_at: new Date(0).toISOString(),
    })
    return
  }
  const data = catalog.map((model) => ({
    type: 'model',
    id: model.id,
    display_name: model.name,
    created_at: new Date(0).toISOString(),
  }))
  sendJson(res, 200, {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
  })
}

async function handle(req, res, control) {
  if (!hostAllowed(req.headers.host)) {
    sendError(res, 403, 'permission_error', 'Host 必须是本机回环地址')
    return
  }
  if (!originAllowed(req.headers.origin)) {
    sendError(res, 403, 'permission_error', 'Origin 必须是本机回环地址')
    return
  }
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const pathname = url.pathname.replace(/\/+$/u, '') || '/'

  if (req.method === 'POST' && pathname === STOP_PATH) {
    const token = req.headers['x-wcc-stop-token']
    if (typeof token !== 'string' || !safeEqual(token, control.token)) {
      sendError(res, 403, 'permission_error', '停止代理需要本机控制令牌')
      return
    }
    res.once('finish', control.shutdown)
    sendJson(res, 200, { ok: true })
    return
  }
  if (!authorized(req)) {
    sendError(res, 401, 'authentication_error', '代理令牌不正确')
    return
  }

  if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/health')) {
    const status = await credentialStatus()
    sendJson(res, 200, {
      ok: true,
      region: VARIANT,
      signedIn: status.state === 'signed-in',
      account: status.nickname ?? status.uid ?? null,
      models: knownModelIds().length,
    })
    return
  }
  if (req.method === 'GET' && pathname === '/v1/models') {
    await handleModels(req, res, pathname)
    return
  }
  if (req.method === 'GET' && pathname.startsWith('/v1/models/')) {
    await handleModels(req, res, pathname)
    return
  }
  if (req.method === 'POST' && pathname === '/v1/messages') {
    await handleMessages(req, res)
    return
  }
  if (req.method === 'POST' && pathname === '/v1/messages/count_tokens') {
    await handleCountTokens(req, res)
    return
  }
  sendError(res, 404, 'not_found_error', `没有路由：${req.method} ${pathname}`)
}

function startServer() {
  const token = randomBytes(32).toString('hex')
  let registration
  let shuttingDown = false
  const server = createServer((req, res) => {
    handle(req, res, { token, shutdown }).catch((error) => {
      debugLog('未处理异常:', error)
      if (!res.headersSent) sendError(res, 500, 'api_error', `代理内部错误：${String(error)}`)
      else res.end()
    })
  })
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`端口 ${config.port} 已被占用；用 WORKBUDDY_PROXY_PORT 换一个端口`)
    } else {
      console.error('[workbuddy-claude] 启动失败:', error)
    }
    process.exitCode = 1
  })
  server.listen(config.port, config.host, async () => {
    registration = registerService(server.address(), token)
    try {
      await registration
    } catch (error) {
      console.error('[workbuddy-claude] 保存运行状态失败:', error.message)
      server.close()
      process.exitCode = 1
      return
    }
    if (shuttingDown) return
    log(`监听 http://${config.host}:${server.address().port}（地区：${VARIANT}）`)
    const status = await credentialStatus()
    if (status.state === 'signed-in') {
      log(`WorkBuddy 账号：${status.nickname ?? status.uid ?? '已登录'}`)
      const credential = await resolveCredential().catch(() => undefined)
      if (credential !== undefined) {
        const models = await ensureCatalog(credential)
        if (models.length > 0) {
          log(`可用模型：${models.length} 个（默认 ${config.defaultModel}）`)
        }
      }
    } else {
      log('尚未登录 WorkBuddy：', status.reason ?? '请先打开 WorkBuddy 桌面 App 登录')
    }
    log('Claude Code 配置示例：')
    log(`  ANTHROPIC_BASE_URL=http://${config.host}:${config.port}`)
    log('  ANTHROPIC_AUTH_TOKEN=workbuddy-local')
    log(`  ANTHROPIC_MODEL=${config.defaultModel}`)
  })
  function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    log('正在关闭代理…')
    server.close(async () => {
      try {
        await registration
        await unregisterService(token)
        process.exit(0)
      } catch (error) {
        console.error('[workbuddy-claude] 清理运行状态失败:', error.message)
        process.exit(1)
      }
    })
    server.closeAllConnections()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function printStatus() {
  const status = await credentialStatus()
  console.log(`地区: ${VARIANT}`)
  if (status.state === 'signed-in') {
    console.log(`账号: ${status.nickname ?? '(无昵称)'} ${status.uid ?? ''}`)
    console.log(`域名: ${status.domain ?? '(未知)'}`)
    console.log(`来源: ${status.source}`)
    console.log(`过期: ${new Date(status.expiresAtMs).toLocaleString()}`)
    const credential = await resolveCredential()
    const models = await ensureCatalog(credential, { force: true })
    console.log(`模型 (${models.length}):`)
    for (const model of models) {
      console.log(
        `  ${model.id.padEnd(28)} ${model.name}` +
          `  上下文 ${Math.round(model.contextWindow / 1000)}k / 输出 ${Math.round(model.maxTokens / 1000)}k`,
      )
    }
  } else {
    console.log('未登录:', status.reason ?? '请打开 WorkBuddy App 登录')
  }
}

function printEnv() {
  const model = config.defaultModel
  console.log(`export ANTHROPIC_BASE_URL="http://${config.host}:${config.port}"`)
  console.log('export ANTHROPIC_AUTH_TOKEN="workbuddy-local"')
  console.log(`export ANTHROPIC_MODEL="${model}"`)
  console.log(`export ANTHROPIC_DEFAULT_OPUS_MODEL="${model}"`)
  console.log(`export ANTHROPIC_DEFAULT_SONNET_MODEL="${model}"`)
  console.log(`export ANTHROPIC_DEFAULT_HAIKU_MODEL="${model}"`)
  console.log('export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"')
}

const args = process.argv.slice(2)
const command = args[0] ?? 'start'
if (args.length > 1) {
  console.error('一次只接受一个命令；运行 wcc --help 查看用法')
  process.exitCode = 1
} else if (command === 'check' || command === '--check' || command === '--status') {
  await printStatus()
} else if (command === 'env' || command === '--print-env') {
  printEnv()
} else if (command === 'stop') {
  try {
    const stopped = await stopService()
    console.log(stopped ? '代理已停止' : `未发现运行中的代理（端口 ${config.port}）`)
  } catch (error) {
    console.error('停止代理失败:', error.message)
    process.exitCode = 1
  }
} else if (command === 'help' || command === '--help' || command === '-h') {
  console.log('用法: wcc [start|stop|check|env|--version|--help]')
  console.log('兼容命令: workbuddy-claude-cli')
  console.log('  start       启动本地代理（默认命令）')
  console.log('  stop        停止本机运行中的代理')
  console.log('  check       打印登录状态与可用模型（也支持 --check）')
  console.log('  env         打印 Claude CLI 环境变量示例（也支持 --print-env）')
  console.log('  --version   打印版本号')
} else if (command === '--version' || command === '-v') {
  const metadata = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  console.log(metadata.version)
} else if (command === 'start') {
  startServer()
} else {
  console.error(`未知命令：${command}；运行 wcc --help 查看用法`)
  process.exitCode = 1
}

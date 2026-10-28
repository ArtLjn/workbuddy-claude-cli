// OpenAI HTTP 入口：复用 WorkBuddy 登录态与上游，不参与客户端的工具权限决策。
import { once } from 'node:events'
import { config, debugLog, log } from './config.mjs'
import { resolveCredential } from './credential.mjs'
import {
  readBody,
  sendJson,
  sendError,
  statusForKind,
  errorTypeForKind,
  upstreamErrorMessage,
} from './http.mjs'
import { collectChatCompletion, completionChunks, toWorkBuddyChat } from './openai.mjs'
import { UpstreamError, chatStream, ensureCatalog } from './upstream.mjs'

export async function handleChatCompletions(req, res, dependencies = {}) {
  const resolve = dependencies.resolveCredential ?? resolveCredential
  const catalogOf = dependencies.ensureCatalog ?? ensureCatalog
  const chat = dependencies.chatStream ?? chatStream
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    sendError(res, 415, 'invalid_request_error', 'Content-Type 必须是 application/json')
    return
  }
  let body
  let prepared
  try {
    body = JSON.parse(await readBody(req))
    prepared = toWorkBuddyChat(body, [])
  } catch (error) {
    sendError(res, 400, 'invalid_request_error', error.message)
    return
  }
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) controller.abort()
  })
  const timeout =
    Number.isFinite(config.requestTimeoutMs) && config.requestTimeoutMs > 0
      ? AbortSignal.timeout(config.requestTimeoutMs)
      : undefined
  const signal = timeout ? AbortSignal.any([controller.signal, timeout]) : controller.signal
  try {
    let credential
    try {
      credential = await resolve()
    } catch (error) {
      sendError(res, 401, 'authentication_error', error.message)
      return
    }
    const catalog = await catalogOf(credential)
    if (catalog.length > 0 && !catalog.some((model) => model.id === prepared.model)) {
      sendError(res, 404, 'model_not_found', `没有模型 ${prepared.model}；请查看 /v1/models`)
      return
    }
    prepared = toWorkBuddyChat(body, catalog)
    log(`→ OpenAI ${prepared.model}（${prepared.messages.length} 条消息）`)
    const upstream = await chat(credential, prepared, signal)
    if (body.stream !== true) {
      sendJson(res, 200, await collectChatCompletion(upstream.body, prepared.model))
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    for await (const chunk of completionChunks(
      upstream.body,
      prepared.model,
      body.stream_options?.include_usage === true,
    )) {
      if (!res.write(chunk)) await once(res, 'drain', { signal })
    }
    res.end()
  } catch (error) {
    if (res.destroyed) return
    const kind = error instanceof UpstreamError ? error.kind : 'server'
    const type = errorTypeForKind(kind)
    const message = upstreamErrorMessage(error)
    if (!res.headersSent) sendError(res, statusForKind(kind), type, message)
    else res.end(`data: ${JSON.stringify({ error: { type, message, code: type } })}\n\n`)
    debugLog('OpenAI 请求失败:', message)
  }
}

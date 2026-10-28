// 共用 HTTP 读写与上游错误映射。
import { UpstreamError } from './upstream.mjs'

const BODY_LIMIT = 64 * 1024 * 1024

export function readBody(req) {
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

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** 两种协议都能读取的错误体；保留 Anthropic 顶层 type。 */
export function sendError(res, status, type, message) {
  sendJson(res, status, { type: 'error', error: { type, message, code: type, param: null } })
}

export function statusForKind(kind) {
  switch (kind) {
    case 'hard_credit':
      return 402
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

export function errorTypeForKind(kind) {
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

export function upstreamErrorMessage(error) {
  if (error instanceof UpstreamError && error.kind === 'session_dead') {
    return `${error.message}（请打开 WorkBuddy App 重新登录）`
  }
  return error.message
}

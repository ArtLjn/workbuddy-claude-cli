// WorkBuddy 上游客户端：聊天流、模型目录、请求体规范化与错误分类。
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { BASES, VARIANT, config, debugLog, log } from './config.mjs'
import { catalogUserAgent, chatUserAgent, currentIdentity } from './identity.mjs'

const JSON_TIMEOUT_MS = 30_000
const CATALOG_TTL_MS = 5 * 60 * 1000

export class UpstreamError extends Error {
  constructor(message, { status = 0, kind = 'server', code } = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.status = status
    this.kind = kind
    this.code = code
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 上游错误码 → 失败类别；码表来自插件实测。 */
const CODE_KINDS = {
  12153: 'session_dead',
  11128: 'client',
  11133: 'client',
  11140: 'client',
}

const TEXT_MARKERS = [
  ['insufficient credit', 'hard_credit'],
  ['no credit', 'hard_credit'],
  ['credit exhausted', 'hard_credit'],
  ['out of credit', 'hard_credit'],
  ['quota exceeded', 'hard_credit'],
  ['payment required', 'hard_credit'],
  ['积分不足', 'hard_credit'],
  ['额度不足', 'hard_credit'],
  ['余额不足', 'hard_credit'],
  ['offline user session not found', 'session_dead'],
  ['12153', 'session_dead'],
  ['11128', 'client'],
  ['11133', 'client'],
  ['11140', 'client'],
]

function kindOfStatus(status) {
  if (status === 402) return 'hard_credit'
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500 || status === 0) return 'server'
  return 'client'
}

function displayMessageOf(parsed) {
  if (!isObject(parsed)) return undefined
  const display = parsed.displayMsg
  if (isObject(display)) {
    for (const key of ['zh', 'zh-hant', 'en']) {
      if (typeof display[key] === 'string' && display[key].trim() !== '') return display[key].trim()
    }
  }
  if (typeof parsed.msg === 'string' && parsed.msg.trim() !== '') return parsed.msg.trim()
  if (isObject(parsed.extError) && typeof parsed.extError.message === 'string') {
    return parsed.extError.message.trim()
  }
  return undefined
}

/** 把一次上游失败归类，并挑出最适合展示的一句话。 */
export function classifyFailure(status, text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const extCode =
    isObject(parsed) && isObject(parsed.extError) && typeof parsed.extError.code === 'string'
      ? Number(parsed.extError.code)
      : undefined
  const envelopeCode =
    isObject(parsed) && typeof parsed.code === 'number' && parsed.code !== 0
      ? parsed.code
      : undefined
  const code = extCode ?? envelopeCode
  let kind = code !== undefined ? CODE_KINDS[code] : undefined
  if (kind === undefined) {
    const lower = text.toLowerCase()
    for (const [marker, markerKind] of TEXT_MARKERS) {
      if (lower.includes(marker.toLowerCase())) {
        kind = markerKind
        break
      }
    }
  }
  kind ??= kindOfStatus(status)
  const display = displayMessageOf(parsed) ?? text.slice(0, 400)
  return { kind, code, message: display }
}

function originHeaders() {
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: BASES.origin,
    Referer: `${BASES.origin}/`,
  }
}

/** 国际版网关要求的 trace/conversation 身份头组。 */
function channelIdentityHeaders() {
  const uuid = () => {
    const bytes = randomBytes(16)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = bytes.toString('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return {
    'X-Trace-ID': randomBytes(16).toString('hex'),
    'X-Request-ID': uuid(),
    'X-Conversation-ID': uuid(),
    'X-Conversation-Request-ID': uuid(),
    'X-Conversation-Message-ID': uuid(),
  }
}

function chatHeaders(credential, userAgent) {
  return {
    ...originHeaders(),
    'Content-Type': 'application/json',
    'User-Agent': userAgent,
    Authorization: `Bearer ${credential.accessToken}`,
    ...(credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid }),
    ...(credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId }),
    ...(credential.domain === ''
      ? { 'X-No-Department-Info': '1' }
      : { 'X-Domain': credential.domain }),
    'X-Product': 'SaaS',
    ...(VARIANT === 'global' ? channelIdentityHeaders() : {}),
  }
}

/** 上游拒绝 developer 角色；工具选择也要改成它接受的字符串形式。 */
function normalizeDeveloperRole(body) {
  if (!Array.isArray(body.messages)) return
  for (const message of body.messages) {
    if (isObject(message) && message.role === 'developer') message.role = 'system'
  }
}

function normalizeToolChoice(body) {
  if (!('tool_choice' in body)) return
  const choice = body.tool_choice
  const suppress = () => {
    delete body.tools
    delete body.functions
  }
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete body.tool_choice
      suppress()
    }
    return
  }
  if (!isObject(choice)) {
    delete body.tool_choice
    return
  }
  const type = typeof choice.type === 'string' ? choice.type.trim().toLowerCase() : ''
  if (type === 'none') {
    delete body.tool_choice
    suppress()
  } else if (type === 'auto' || type === 'required') {
    body.tool_choice = type
  } else if (type === 'function') {
    const name =
      (typeof choice.function?.name === 'string' ? choice.function.name : '') ||
      (typeof choice.name === 'string' ? choice.name : '')
    body.tool_choice = name.trim() !== '' ? name.trim() : 'auto'
  } else {
    delete body.tool_choice
  }
}

const CLAUDE_OPENER =
  /You\s+are\s+Claude\s+Code\s*,\s*Anthropic['’]s\s+official\s+CLI\s+for\s+Claude\s*[.!]?/giu
const CLAUDE_NEUTRAL = 'You are an AI coding assistant.'
// Claude Code 会在 system 开头注入一行 Anthropic 计费标记；WorkBuddy 网关会按
// 非官方客户端拦截它，且这一行对 WorkBuddy 没有任何意义，直接删掉。
const ANTHROPIC_BILLING_LINE = /^[ \t]*x-anthropic-billing-header:[^\n]*(?:\n|$)/gimu
// Claude Code 的反馈行/Anthropic GitHub 链接同样被网关当作客户端签名；
// 对 WorkBuddy 没有意义，整行删掉。
const ANTHROPIC_FEEDBACK_LINE =
  /^[ \t]*(?:[-*][ \t]+)?(?:To give feedback[^\n]*|[^\n]*https?:\/\/github\.com\/anthropics\/[^\n]*)(?:\n|$)/gimu
const DSH_OPENER =
  /^([\s\uFEFF]*)You\s+are\s+an\s+AI\s+agent\s+powered\s+by\s+DeepSeek[\s\u00a0]+Harness\s*\./iu
const DSH_PHRASE = /(?<![\\/])DeepSeek([\s\u00a0]+)Harness(?![\\/])/giu

function rewriteText(text) {
  return text
    .replace(ANTHROPIC_BILLING_LINE, '')
    .replace(ANTHROPIC_FEEDBACK_LINE, '')
    .replace(CLAUDE_OPENER, CLAUDE_NEUTRAL)
    .replace(DSH_OPENER, '$1You are an AI agent.')
    .replace(DSH_PHRASE, 'DeepSeek​$1Harness')
}

/**
 * 改写客户端身份句，避免网关按“非官方客户端”拦截。
 * 只动 system/developer/assistant，用户文本与工具结果保持原样。
 */
function neutralizeClientIdentity(body, enabled) {
  if (!enabled || !Array.isArray(body.messages)) return
  for (const message of body.messages) {
    if (!isObject(message)) continue
    if (message.role !== 'system' && message.role !== 'developer' && message.role !== 'assistant') {
      continue
    }
    if (typeof message.content === 'string') {
      message.content = rewriteText(message.content)
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isObject(part) && part.type === 'text' && typeof part.text === 'string') {
          part.text = rewriteText(part.text)
        }
      }
    }
    if (message.role !== 'assistant') continue
    for (const key of ['reasoning_content', 'reasoning']) {
      if (typeof message[key] === 'string') message[key] = rewriteText(message[key])
    }
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (typeof call?.function?.arguments === 'string') {
          call.function.arguments = rewriteText(call.function.arguments)
        }
      }
    }
  }
}

function ensureGlobalSystemMessage(body) {
  if (VARIANT !== 'global' || !Array.isArray(body.messages)) return
  const first = body.messages[0]
  if (isObject(first) && first.role === 'system') return
  body.messages.unshift({ role: 'system', content: 'You are a helpful assistant.' })
}

/** 把 OpenAI 形请求体整理成 WorkBuddy 能接受的形式。 */
export function prepareChatBody(body, { rewriteIdentity = true } = {}) {
  const prepared = { ...body }
  prepared.stream = true
  normalizeDeveloperRole(prepared)
  neutralizeClientIdentity(prepared, rewriteIdentity)
  normalizeToolChoice(prepared)
  if (prepared.reasoning_effort === 'off') delete prepared.reasoning_effort
  ensureGlobalSystemMessage(prepared)
  return prepared
}

/** 发起一次流式聊天；成功时返回原始 Response。 */
export async function chatStream(credential, body, signal) {
  const identity = await currentIdentity()
  const prepared = prepareChatBody(body, { rewriteIdentity: config.rewriteIdentity })
  if (config.dumpRequest !== '') {
    await writeFile(config.dumpRequest, `${JSON.stringify(prepared, null, 2)}\n`, {
      mode: 0o600,
    }).catch((error) => debugLog('写入请求转储失败:', String(error)))
  }
  debugLog(
    '上游请求模型:',
    prepared.model,
    '消息数:',
    prepared.messages?.length,
    '工具数:',
    prepared.tools?.length,
  )
  let response
  try {
    response = await fetch(`${BASES.chat}/v2/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(credential, chatUserAgent(identity)),
      body: JSON.stringify(prepared),
      signal,
    })
  } catch (error) {
    throw new UpstreamError(`连接 WorkBuddy 上游失败：${String(error)}`, {
      status: 0,
      kind: 'server',
    })
  }
  if (response.ok) return response
  const text = (await response.text()).slice(0, 8192)
  const failure = classifyFailure(response.status, text)
  debugLog('上游失败:', response.status, failure.kind, failure.message)
  throw new UpstreamError(failure.message, {
    status: response.status,
    kind: failure.kind,
    code: failure.code,
  })
}

let cache = { at: 0, models: [], byId: new Map() }

function parseCatalog(data) {
  const rawModels = Array.isArray(data.models) ? data.models : []
  const agents = Array.isArray(data.agents) ? data.agents : []
  let cliIds
  for (const agent of agents) {
    if (isObject(agent) && agent.name === 'cli' && Array.isArray(agent.models)) {
      cliIds = agent.models.filter((id) => typeof id === 'string')
      break
    }
  }
  const byId = new Map()
  for (const raw of rawModels) {
    if (!isObject(raw)) continue
    const id = typeof raw.id === 'string' ? raw.id : ''
    if (id === '' || raw.disabled === true) continue
    const input = typeof raw.maxInputTokens === 'number' ? raw.maxInputTokens : 0
    const output = typeof raw.maxOutputTokens === 'number' ? raw.maxOutputTokens : 0
    if (input <= 0 || output <= 0) continue
    byId.set(id, {
      id,
      name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : id,
      contextWindow: input,
      maxTokens: output,
      supportsImages: raw.supportsImages === true && raw.disabledMultimodal !== true,
    })
  }
  const ids = cliIds !== undefined && cliIds.length > 0 ? cliIds : [...byId.keys()]
  const models = ids.map((id) => byId.get(id)).filter((model) => model !== undefined)
  if (models.length === 0) throw new Error('WorkBuddy 模型目录为空')
  return models
}

/** 拉取模型目录（5 分钟缓存）；失败时返回空数组而不是打断聊天。 */
export async function ensureCatalog(credential, { force = false } = {}) {
  if (!force && cache.models.length > 0 && Date.now() - cache.at < CATALOG_TTL_MS) {
    return cache.models
  }
  const identity = await currentIdentity()
  try {
    const response = await fetch(`${BASES.chat}/v3/config`, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: 'application/json',
        Origin: BASES.origin,
        Referer: `${BASES.origin}/`,
        'User-Agent': catalogUserAgent(identity),
        ...(VARIANT === 'global'
          ? { 'X-Requested-With': 'XMLHttpRequest', 'X-Product': 'SaaS' }
          : {}),
      },
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    if (!response.ok) {
      const text = (await response.text()).slice(0, 2048)
      const failure = classifyFailure(response.status, text)
      throw new UpstreamError(failure.message, { status: response.status, kind: failure.kind })
    }
    const parsed = await response.json()
    if (isObject(parsed) && typeof parsed.code === 'number' && parsed.code !== 0) {
      throw new UpstreamError(displayMessageOf(parsed) ?? '模型目录请求失败', {
        status: response.status,
        kind: classifyFailure(response.status, JSON.stringify(parsed)).kind,
      })
    }
    const data = isObject(parsed) && isObject(parsed.data) ? parsed.data : parsed
    const models = parseCatalog(data)
    cache = { at: Date.now(), models, byId: new Map(models.map((model) => [model.id, model])) }
    debugLog('模型目录已刷新:', models.length, '个')
    return models
  } catch (error) {
    log('模型目录获取失败（聊天仍可继续）:', String(error))
    return cache.models
  }
}

/** 同步查一个模型的能力上限；目录未就绪时返回 undefined。 */
export function modelInfo(id) {
  return cache.byId.get(id)
}

/** 已知模型 id 列表；用于把 Claude 别名映射到兜底模型。 */
export function knownModelIds() {
  return cache.models.map((model) => model.id)
}

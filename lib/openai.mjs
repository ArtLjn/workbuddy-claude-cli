// OpenAI Chat Completions 请求校验与响应聚合，保留工具调用和推理字段。
import { randomUUID } from 'node:crypto'
import { config } from './config.mjs'
import { readChatFrames } from './sse.mjs'

const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool'])

export function toWorkBuddyChat(body, catalog) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  if (typeof body.model !== 'string' || body.model.trim() === '') {
    throw new Error('请求缺少 model')
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new Error('请求需要非空 messages 数组')
  }
  for (const message of body.messages) {
    if (!message || !ROLES.has(message.role)) throw new Error('messages 包含无效角色')
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw new Error('stream 必须是布尔值')
  }
  if (body.n !== undefined && body.n !== 1) throw new Error('仅支持 n=1')
  const prepared = structuredClone(body)
  prepared.model = body.model.trim()
  const limit = body.max_completion_tokens ?? body.max_tokens
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error('输出 token 上限必须是正整数')
    const model = catalog.find((entry) => entry.id === prepared.model)
    prepared.max_tokens = Math.min(limit, model?.maxTokens ?? limit)
  }
  delete prepared.max_completion_tokens
  // stream_options 属于下游；上游始终流式返回，代理自己按请求组装 usage。
  delete prepared.stream_options
  if (config.reasoningEffort !== '') prepared.reasoning_effort = config.reasoningEffort
  return prepared
}

/** 聚合 SSE，不能把连接中断留下的半截工具参数作为完整调用返回。 */
export async function collectChatCompletion(stream, model) {
  const result = {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
  }
  const message = { role: 'assistant', content: null }
  const tools = new Map()
  let finishReason
  for await (const frame of readChatFrames(stream)) {
    if (typeof frame.id === 'string') result.id = frame.id
    if (typeof frame.created === 'number') result.created = frame.created
    if (frame.usage) result.usage = frame.usage
    const choice = frame.choices?.[0]
    if (!choice) continue
    const delta = choice.delta ?? {}
    if (typeof delta.content === 'string') message.content = (message.content ?? '') + delta.content
    for (const key of ['reasoning_content', 'refusal']) {
      if (typeof delta[key] === 'string') message[key] = (message[key] ?? '') + delta[key]
    }
    for (const call of delta.tool_calls ?? []) {
      const index = Number.isInteger(call.index) ? call.index : 0
      let tool = tools.get(index)
      if (!tool) {
        tool = { id: '', type: 'function', function: { name: '', arguments: '' } }
        tools.set(index, tool)
      }
      if (typeof call.id === 'string' && call.id !== '') tool.id = call.id
      if (typeof call.function?.name === 'string') tool.function.name += call.function.name
      if (typeof call.function?.arguments === 'string') {
        tool.function.arguments += call.function.arguments
      }
    }
    if (typeof choice.finish_reason === 'string')
      finishReason = choice.finish_reason || finishReason
  }
  if (!finishReason) throw new Error('上游流提前结束，缺少 finish_reason')
  if (tools.size > 0) {
    message.tool_calls = [...tools.entries()].sort(([a], [b]) => a - b).map(([, tool]) => tool)
    if (message.tool_calls.some((tool) => !tool.id || !tool.function.name)) {
      throw new Error('上游工具调用缺少 id 或函数名')
    }
  }
  result.choices = [{ index: 0, message, finish_reason: finishReason, logprobs: null }]
  return result
}

/** 流式保持 OpenAI 增量，不经 Anthropic 转换，避免丢失推理和工具参数。 */
export async function* completionChunks(stream, model, includeUsage = false) {
  let finished = false
  let id = `chatcmpl-${randomUUID()}`
  let created = Math.floor(Date.now() / 1000)
  for await (const frame of readChatFrames(stream)) {
    if (typeof frame.id === 'string') id = frame.id
    if (typeof frame.created === 'number') created = frame.created
    if (frame.choices?.some((choice) => choice.finish_reason)) finished = true
    const chunk = { ...frame, id, created, object: 'chat.completion.chunk', model }
    if (!includeUsage) delete chunk.usage
    if (chunk.choices?.length === 0 && !includeUsage) continue
    yield `data: ${JSON.stringify(chunk)}\n\n`
  }
  if (!finished) throw new Error('上游流提前结束，缺少 finish_reason')
  yield 'data: [DONE]\n\n'
}

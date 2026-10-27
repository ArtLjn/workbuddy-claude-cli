// Anthropic Messages API ↔ WorkBuddy（OpenAI 兼容）协议转换。
import { randomBytes } from 'node:crypto'
import { config, debugLog } from './config.mjs'
import { modelInfo } from './upstream.mjs'

const DEFAULT_MAX_TOKENS = 8192

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function randomId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`
}

/** 粗略估算 token；用于 count_tokens 与 message_start 的初始值。 */
export function estimateTokens(input) {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? '')
  return Math.max(1, Math.ceil(text.length / 4))
}

/** system 既可能是字符串，也可能是文本块数组。 */
function systemToString(system) {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .filter((block) => isObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n')
}

/** 把 Anthropic 图片块转成 OpenAI image_url。 */
function imagePart(block) {
  const source = block.source
  if (!isObject(source)) return undefined
  if (source.type === 'base64' && typeof source.data === 'string') {
    const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png'
    return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${source.data}` } }
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    return { type: 'image_url', image_url: { url: source.url } }
  }
  return undefined
}

/** 工具结果内容可能是字符串，也可能是文本块数组。 */
function toolResultText(block) {
  const content = block.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const text = content
      .filter((part) => isObject(part) && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
    return text === '' ? '[tool result]' : text
  }
  if (content === undefined || content === null) return '[tool result]'
  return JSON.stringify(content)
}

function toolResultMessages(block) {
  return {
    role: 'tool',
    tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
    content: toolResultText(block),
  }
}

function assistantMessage(blocks) {
  const texts = []
  const toolCalls = []
  for (const block of blocks) {
    if (!isObject(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: typeof block.id === 'string' ? block.id : randomId('call'),
        type: 'function',
        function: {
          name: typeof block.name === 'string' ? block.name : '',
          arguments: JSON.stringify(isObject(block.input) ? block.input : {}),
        },
      })
    }
    // thinking / redacted_thinking 不回传；图片在 assistant 轮次中也不常见。
  }
  const text = texts.join('')
  if (toolCalls.length > 0) {
    return { role: 'assistant', content: text === '' ? null : text, tool_calls: toolCalls }
  }
  return text === '' ? undefined : { role: 'assistant', content: text }
}

function userMessages(blocks) {
  const toolMessages = []
  const parts = []
  for (const block of blocks) {
    if (!isObject(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const image = imagePart(block)
      if (image !== undefined) parts.push(image)
    } else if (block.type === 'tool_result') {
      toolMessages.push(toolResultMessages(block))
    }
    // document 等其它类型暂不转发。
  }
  const messages = [...toolMessages]
  if (parts.length > 0) {
    const onlyText = parts.every((part) => part.type === 'text')
    messages.push({
      role: 'user',
      content: onlyText ? parts.map((part) => part.text).join('') : parts,
    })
  }
  return messages
}

function convertMessages(messages) {
  const converted = []
  for (const message of messages) {
    if (!isObject(message)) continue
    if (typeof message.content === 'string') {
      converted.push({ role: message.role, content: message.content })
      continue
    }
    if (!Array.isArray(message.content)) continue
    if (message.role === 'assistant') {
      const assistant = assistantMessage(message.content)
      if (assistant !== undefined) converted.push(assistant)
    } else if (message.role === 'user') {
      converted.push(...userMessages(message.content))
    } else if (message.role === 'system') {
      const text = systemToString(message.content)
      if (text !== '') converted.push({ role: 'system', content: text })
    }
  }
  return converted
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined
  const converted = tools.flatMap((tool) => {
    if (!isObject(tool) || typeof tool.name !== 'string' || tool.name === '') return []
    return [
      {
        type: 'function',
        function: {
          name: tool.name,
          ...(typeof tool.description === 'string' && tool.description !== ''
            ? { description: tool.description }
            : {}),
          parameters: isObject(tool.input_schema)
            ? tool.input_schema
            : { type: 'object', properties: {} },
        },
      },
    ]
  })
  return converted.length === 0 ? undefined : converted
}

function convertToolChoice(choice) {
  if (!isObject(choice)) return undefined
  if (choice.type === 'auto') return 'auto'
  if (choice.type === 'any') return 'required'
  if (choice.type === 'none') return 'none'
  if (choice.type === 'tool' && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } }
  }
  return undefined
}

/** Anthropic Messages 请求 → OpenAI chat completions 请求体。 */
export function toOpenAIChat(body, upstreamModel) {
  if (!Array.isArray(body.messages)) throw new Error('请求缺少 messages 数组')
  const info = modelInfo(upstreamModel)
  const requestedMax = Number.isFinite(body.max_tokens) ? body.max_tokens : DEFAULT_MAX_TOKENS
  const maxTokens =
    info?.maxTokens !== undefined ? Math.min(requestedMax, info.maxTokens) : requestedMax

  const openai = {
    model: upstreamModel,
    messages: [],
    max_tokens: Math.max(1, Math.floor(maxTokens)),
    stream: true,
  }
  const system = systemToString(body.system)
  if (system !== '') openai.messages.push({ role: 'system', content: system })
  openai.messages.push(...convertMessages(body.messages))

  const tools = convertTools(body.tools)
  if (tools !== undefined) openai.tools = tools
  const toolChoice = convertToolChoice(body.tool_choice)
  if (tools !== undefined && toolChoice !== undefined) openai.tool_choice = toolChoice
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    openai.stop = body.stop_sequences
  }
  if (typeof body.temperature === 'number') openai.temperature = body.temperature
  if (typeof body.top_p === 'number') openai.top_p = body.top_p
  if (config.reasoningEffort !== '') openai.reasoning_effort = config.reasoningEffort
  return openai
}

function mapStopReason(reason, hasToolUse) {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  if (hasToolUse) return 'tool_use'
  return 'end_turn'
}

function writeEvent(emit, event, data) {
  emit(event, data)
}

/**
 * 把上游 SSE 流翻译成 Anthropic SSE 事件。
 * `emit(event, data)` 由调用方负责真正写响应。
 */
export async function translateStream(stream, { model, inputTokens, emit }) {
  const messageId = randomId('msg')
  const state = {
    nextIndex: 0,
    text: undefined,
    thinking: undefined,
    tools: new Map(),
    blocks: [],
    stopReason: '',
    usage: { input_tokens: inputTokens, output_tokens: 0 },
  }

  writeEvent(emit, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  })

  const closeBlock = (block) => {
    if (block === undefined || block.closed) return
    if (block.type === 'thinking') {
      writeEvent(emit, 'content_block_delta', {
        type: 'content_block_delta',
        index: block.index,
        delta: { type: 'signature_delta', signature: 'workbuddy' },
      })
    }
    writeEvent(emit, 'content_block_stop', { type: 'content_block_stop', index: block.index })
    block.closed = true
  }

  const closeTextAndThinking = () => {
    closeBlock(state.text)
    state.text = undefined
    closeBlock(state.thinking)
    state.thinking = undefined
  }

  const ensureText = () => {
    if (state.text !== undefined) return state.text
    const block = { type: 'text', index: state.nextIndex++, closed: false }
    state.text = block
    state.blocks.push(block)
    writeEvent(emit, 'content_block_start', {
      type: 'content_block_start',
      index: block.index,
      content_block: { type: 'text', text: '' },
    })
    return block
  }

  const ensureThinking = () => {
    if (state.thinking !== undefined) return state.thinking
    const block = { type: 'thinking', index: state.nextIndex++, closed: false }
    state.thinking = block
    state.blocks.push(block)
    writeEvent(emit, 'content_block_start', {
      type: 'content_block_start',
      index: block.index,
      content_block: { type: 'thinking', thinking: '' },
    })
    return block
  }

  const handleToolCall = (call) => {
    const key = Number.isInteger(call.index) ? call.index : 0
    let entry = state.tools.get(key)
    if (entry === undefined) {
      entry = {
        type: 'tool_use',
        index: state.nextIndex++,
        id: typeof call.id === 'string' && call.id !== '' ? call.id : randomId('toolu'),
        name: '',
        args: '',
        flushed: false,
        closed: false,
      }
      state.tools.set(key, entry)
      state.blocks.push(entry)
    }
    if (typeof call.function?.name === 'string' && call.function.name !== '' && entry.name === '') {
      entry.name = call.function.name
    }
    const fragment = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
    if (fragment !== '') {
      entry.args += fragment
      if (entry.flushed) {
        writeEvent(emit, 'content_block_delta', {
          type: 'content_block_delta',
          index: entry.index,
          delta: { type: 'input_json_delta', partial_json: fragment },
        })
      }
    }
    if (!entry.flushed && entry.name !== '') {
      closeTextAndThinking()
      writeEvent(emit, 'content_block_start', {
        type: 'content_block_start',
        index: entry.index,
        content_block: { type: 'tool_use', id: entry.id, name: entry.name, input: {} },
      })
      entry.flushed = true
      if (entry.args !== '') {
        writeEvent(emit, 'content_block_delta', {
          type: 'content_block_delta',
          index: entry.index,
          delta: { type: 'input_json_delta', partial_json: entry.args },
        })
      }
    }
  }

  const handleDelta = (delta) => {
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      if (config.showReasoning) {
        ensureThinking()
        writeEvent(emit, 'content_block_delta', {
          type: 'content_block_delta',
          index: state.thinking.index,
          delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
        })
      }
    }
    if (typeof delta.content === 'string' && delta.content !== '') {
      closeBlock(state.thinking)
      state.thinking = undefined
      ensureText()
      writeEvent(emit, 'content_block_delta', {
        type: 'content_block_delta',
        index: state.text.index,
        delta: { type: 'text_delta', text: delta.content },
      })
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) if (isObject(call)) handleToolCall(call)
    }
  }

  const consumeFrame = (payload) => {
    if (payload === '' || payload === '[DONE]') return
    let frame
    try {
      frame = JSON.parse(payload)
    } catch {
      return
    }
    if (!isObject(frame)) return
    if (isObject(frame.error)) {
      throw new Error(frame.error.message ?? JSON.stringify(frame.error))
    }
    if (isObject(frame.usage)) {
      if (typeof frame.usage.prompt_tokens === 'number' && frame.usage.prompt_tokens > 0) {
        state.usage.input_tokens = frame.usage.prompt_tokens
      }
      if (typeof frame.usage.completion_tokens === 'number') {
        state.usage.output_tokens = frame.usage.completion_tokens
      }
      if (typeof frame.usage.credit === 'number') state.usage.credit = frame.usage.credit
    }
    const choice = Array.isArray(frame.choices) ? frame.choices[0] : undefined
    if (!isObject(choice)) return
    if (isObject(choice.delta)) handleDelta(choice.delta)
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
      state.stopReason = choice.finish_reason
    }
  }

  const decoder = new TextDecoder()
  let carry = ''
  for await (const chunk of stream) {
    carry += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let newline
    while ((newline = carry.indexOf('\n')) >= 0) {
      const line = carry.slice(0, newline).replace(/\r$/u, '')
      carry = carry.slice(newline + 1)
      if (line.startsWith('data:')) consumeFrame(line.slice(5).trim())
    }
  }
  if (carry.trim() !== '' && carry.startsWith('data:')) consumeFrame(carry.slice(5).trim())

  closeTextAndThinking()
  // 只有真正发出过 content_block_start 的工具块才能关闭；缺名字的残块直接丢弃。
  for (const block of [...state.blocks]) {
    if (block.type !== 'tool_use') continue
    if (!block.flushed) {
      state.blocks = state.blocks.filter((candidate) => candidate !== block)
      debugLog('丢弃缺少函数名的工具调用块', block.id)
      continue
    }
    closeBlock(block)
  }
  if (state.blocks.length === 0) {
    const block = ensureText()
    closeBlock(block)
    state.text = undefined
  }

  const hasToolUse = state.blocks.some((block) => block.type === 'tool_use' && block.flushed)
  const stopReason = mapStopReason(state.stopReason, hasToolUse)
  debugLog('上游流结束:', stopReason, state.usage)
  writeEvent(emit, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: state.usage.output_tokens },
  })
  writeEvent(emit, 'message_stop', { type: 'message_stop' })
  return { stopReason, usage: state.usage }
}

/** 非流式请求：把同一套事件合并成完整消息。 */
export async function collectMessage(stream, options) {
  const events = []
  const summary = await translateStream(stream, {
    ...options,
    emit: (event, data) => events.push({ event, data }),
  })
  const start = events.find((entry) => entry.event === 'message_start')?.data.message
  const blocks = new Map()
  let stopReason = summary.stopReason
  for (const { event, data } of events) {
    if (event === 'content_block_start') {
      blocks.set(data.index, { ...data.content_block, partialJson: '' })
    } else if (event === 'content_block_delta') {
      const block = blocks.get(data.index)
      if (block === undefined) continue
      if (data.delta.type === 'text_delta') block.text += data.delta.text
      if (data.delta.type === 'thinking_delta') block.thinking += data.delta.thinking
      if (data.delta.type === 'input_json_delta') block.partialJson += data.delta.partial_json
    } else if (event === 'message_delta') {
      stopReason = data.delta.stop_reason
    }
  }
  const content = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => {
      if (block.type === 'tool_use') {
        let input
        try {
          input = block.partialJson === '' ? {} : JSON.parse(block.partialJson)
        } catch {
          input = { _raw: block.partialJson }
        }
        return { type: 'tool_use', id: block.id, name: block.name, input }
      }
      if (block.type === 'thinking') {
        return { type: 'thinking', thinking: block.thinking, signature: 'workbuddy' }
      }
      return { type: 'text', text: block.text }
    })
  return {
    id: start?.id ?? randomId('msg'),
    type: 'message',
    role: 'assistant',
    model: start?.model ?? options.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: summary.usage.input_tokens,
      output_tokens: summary.usage.output_tokens,
    },
  }
}

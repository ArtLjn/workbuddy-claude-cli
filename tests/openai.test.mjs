import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import test from 'node:test'
import { handleChatCompletions } from '../lib/chat-route.mjs'
import { collectChatCompletion, completionChunks, toWorkBuddyChat } from '../lib/openai.mjs'
import { readChatFrames } from '../lib/sse.mjs'
import { prepareChatBody, UpstreamError } from '../lib/upstream.mjs'

const model = 'test-model'
const catalog = [{ id: model, maxTokens: 4096 }]
const body = { model, messages: [{ role: 'user', content: '你好' }] }

async function* sse(frames) {
  for (const frame of frames) yield `data: ${JSON.stringify(frame)}\n\n`
  yield 'data: [DONE]\n\n'
}

const frames = [
  {
    id: 'chatcmpl-test',
    created: 123,
    choices: [
      { index: 0, delta: { role: 'assistant', reasoning_content: '分析' }, finish_reason: null },
    ],
  },
  { choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
]

test('OpenAI 请求保留工具历史、图片和推理，规范化不改原请求', () => {
  const original = {
    ...body,
    max_completion_tokens: 9000,
    stream_options: { include_usage: true },
    reasoning_effort: 'off',
    messages: [
      { role: 'developer', content: '规则' },
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,test' } }],
      },
      {
        role: 'assistant',
        content: null,
        reasoning_content: '历史推理',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'terminal', arguments: '{"command":"pwd"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '真实工具结果' },
    ],
    tools: [{ type: 'function', function: { name: 'terminal', parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'terminal' } },
  }
  const snapshot = structuredClone(original)
  const prepared = prepareChatBody(toWorkBuddyChat(original, catalog))
  assert.equal(prepared.stream, true)
  assert.equal(prepared.max_tokens, 4096)
  assert.equal(prepared.max_completion_tokens, undefined)
  assert.equal(prepared.stream_options, undefined)
  assert.equal(prepared.reasoning_effort, undefined)
  assert.equal(prepared.tool_choice, 'terminal')
  assert.equal(prepared.messages[0].role, 'system')
  assert.deepEqual(prepared.messages.slice(1), original.messages.slice(1))
  assert.deepEqual(original, snapshot)
})

test('OpenAI 无效输入在请求上游前报错', () => {
  for (const invalid of [
    null,
    [],
    {},
    { ...body, model: '' },
    { ...body, messages: [] },
    { ...body, messages: [null] },
    { ...body, n: 2 },
    { ...body, max_tokens: -1 },
    { ...body, stream: 'true' },
  ]) {
    assert.throws(() => toWorkBuddyChat(invalid, catalog))
  }
})

test('SSE 支持中文逐字节分片、CRLF、注释、多行 data 和无尾换行', async () => {
  const payload =
    ': heartbeat\r\ndata: {"choices": [],\r\ndata: "text": "中文"}\r\n\r\ndata: [DONE]'
  async function* bytes() {
    for (const byte of Buffer.from(payload)) yield Uint8Array.of(byte)
  }
  const result = []
  for await (const frame of readChatFrames(bytes())) result.push(frame)
  assert.deepEqual(result, [{ choices: [], text: '中文' }])
})

test('非流式聚合返回标准 OpenAI 对象，保留 reasoning_content 和 usage', async () => {
  const result = await collectChatCompletion(sse(frames), model)
  assert.equal(result.object, 'chat.completion')
  assert.equal(result.id, 'chatcmpl-test')
  assert.equal(result.created, 123)
  assert.equal(result.model, model)
  assert.deepEqual(result.choices[0].message, {
    role: 'assistant',
    content: '你好',
    reasoning_content: '分析',
  })
  assert.equal(result.choices[0].finish_reason, 'stop')
  assert.deepEqual(result.usage, frames.at(-1).usage)
})

test('交错的并行工具参数按 index 聚合，保留原始 arguments 字符串', async () => {
  const result = await collectChatCompletion(
    sse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, id: 'call_2', function: { name: 'read', arguments: '{"path":' } },
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'terminal', arguments: '{"command":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"pwd"}' } },
                { index: 1, function: { arguments: '"说明.md"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]),
    model,
  )
  const message = result.choices[0].message
  assert.equal(message.content, null)
  assert.deepEqual(
    message.tool_calls.map((tool) => [tool.id, tool.function.arguments]),
    [
      ['call_1', '{"command":"pwd"}'],
      ['call_2', '{"path":"说明.md"}'],
    ],
  )
})

test('流式保持工具增量，仅按 include_usage 输出用量，并以 DONE 收尾', async () => {
  for (const includeUsage of [false, true]) {
    let output = ''
    for await (const chunk of completionChunks(sse(frames), model, includeUsage)) output += chunk
    assert.match(output, /"object":"chat.completion.chunk"/u)
    assert.match(output, /"reasoning_content":"分析"/u)
    assert.equal(output.includes('"usage"'), includeUsage)
    assert.ok(output.endsWith('data: [DONE]\n\n'))
  }
})

test('流式工具参数保留分片与索引，不转成 Anthropic 块', async () => {
  const deltas = [
    {
      tool_calls: [
        {
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name: 'terminal', arguments: '{"command":' },
        },
      ],
    },
    { tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }] },
  ]
  const output = []
  for await (const chunk of completionChunks(
    sse([
      ...deltas.map((delta) => ({ choices: [{ index: 0, delta, finish_reason: null }] })),
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    model,
  )) {
    if (!chunk.includes('[DONE]')) output.push(JSON.parse(chunk.slice(6)))
  }
  assert.deepEqual(
    output.slice(0, 2).map((chunk) => chunk.choices[0].delta),
    deltas,
  )
  assert.ok(
    output.every((chunk) => chunk.id === output[0].id && chunk.created === output[0].created),
  )
})

test('截断流、非法 JSON 和流内错误不能冒充完整成功响应', async () => {
  await assert.rejects(() => collectChatCompletion(sse(frames.slice(0, 1)), model), /提前结束/u)
  await assert.rejects(
    () => collectChatCompletion(sse([{ error: { message: '上游拒绝' } }]), model),
    /上游拒绝/u,
  )
  async function* malformed() {
    yield 'data: {bad}\n\n'
  }
  await assert.rejects(() => collectChatCompletion(malformed(), model), /非法 JSON/u)
})

async function app(t, overrides = {}) {
  const sent = []
  const dependencies = {
    resolveCredential: async () => ({ accessToken: 'fixture-token' }),
    ensureCatalog: async () => catalog,
    chatStream: async (_credential, request, signal) => {
      sent.push({ request, signal })
      return { body: sse(frames) }
    },
    ...overrides,
  }
  const server = createServer((req, res) => handleChatCompletions(req, res, dependencies))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
  return {
    sent,
    post: (value, headers = { 'Content-Type': 'application/json' }) =>
      fetch(url, { method: 'POST', headers, body: JSON.stringify(value) }),
  }
}

test('真实 HTTP 路由支持默认非流式和显式流式', async (t) => {
  const fixture = await app(t)
  const response = await fixture.post(body)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).choices[0].message.content, '你好')
  const streamed = await fixture.post({
    ...body,
    stream: true,
    stream_options: { include_usage: true },
  })
  assert.match(streamed.headers.get('content-type'), /text\/event-stream/u)
  assert.match(await streamed.text(), /data: \[DONE\]/u)
  assert.equal(fixture.sent.length, 2)
})

test('HTTP 路由拒绝错误输入和未知模型，不静默改用别的模型', async (t) => {
  const fixture = await app(t)
  assert.equal((await fixture.post(body, { 'Content-Type': 'text/plain' })).status, 415)
  assert.equal((await fixture.post({ ...body, messages: [] })).status, 400)
  const unknown = await fixture.post({ ...body, model: 'typo-model' })
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).error.code, 'model_not_found')
  assert.equal(fixture.sent.length, 0)
})

test('HTTP 上游限流返回 OpenAI 错误体', async (t) => {
  const fixture = await app(t, {
    chatStream: async () => {
      throw new UpstreamError('请求过快', { kind: 'soft_rate' })
    },
  })
  const response = await fixture.post(body)
  assert.equal(response.status, 429)
  assert.equal((await response.json()).error.message, '请求过快')
})

test('流中途失败返回 error 帧，不发送成功 DONE 标志', async (t) => {
  const fixture = await app(t, {
    chatStream: async () => ({ body: sse([frames[0], { error: { message: '流中断' } }]) }),
  })
  const response = await fixture.post({ ...body, stream: true })
  const text = await response.text()
  assert.match(text, /"error":/u)
  assert.match(text, /流中断/u)
  assert.doesNotMatch(text, /\[DONE\]/u)
})

test('客户端取消响应时中止上游请求', { timeout: 5000 }, async (t) => {
  let abort
  const aborted = new Promise((resolve) => {
    abort = resolve
  })
  const fixture = await app(t, {
    chatStream: async (_credential, _body, signal) => {
      signal.addEventListener('abort', abort, { once: true })
      async function* pending() {
        yield `data: ${JSON.stringify(frames[0])}\n\n`
        await aborted
        signal.throwIfAborted()
      }
      return { body: pending() }
    },
  })
  const response = await fixture.post({ ...body, stream: true })
  const reader = response.body.getReader()
  await reader.read()
  await reader.cancel()
  await aborted
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { collectMessage, translateStream } from '../lib/anthropic.mjs'
import {
  classifyToolUses,
  emptySafeguardResults,
  hasSafeguards,
  parseVerdicts,
  unavailableSafeguardResults,
} from '../lib/safeguard.mjs'

async function* sse(frames) {
  for (const frame of frames) yield `data: ${JSON.stringify(frame)}\n\n`
  yield 'data: [DONE]\n\n'
}

const toolFrames = [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'Bash', arguments: '' },
            },
          ],
        },
        finish_reason: '',
      },
    ],
  },
  {
    choices: [
      {
        delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls"}' } }] },
        finish_reason: 'tool_calls',
      },
    ],
  },
]

const notFlagged = [
  {
    type: 'dangerous_tool_use',
    status: {
      type: 'available',
      tool_uses: { call_1: { type: 'evaluated', outcome: 'not_flagged' } },
    },
  },
]

const credential = { accessToken: 'test-token', uid: '', enterpriseId: '', domain: '' }
const request = {
  messages: [{ role: 'user', content: '看一下目录' }],
  safeguards: [{ type: 'dangerous_tool_use', classifier_context: { permission_mode: 'auto' } }],
}
const toolUses = [{ id: 'call_1', name: 'Bash', input: { command: 'ls' } }]

function installFetch(reply) {
  const sent = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) })
    const frames = [
      {
        choices: [{ delta: { content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      },
    ]
    const payload =
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(payload, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  return {
    sent,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

test('只有危险的工具调用判定才算 safeguards 请求', () => {
  assert.equal(hasSafeguards({}), false)
  assert.equal(hasSafeguards({ safeguards: [] }), false)
  assert.equal(hasSafeguards({ safeguards: [{ type: 'other' }] }), false)
  assert.equal(hasSafeguards({ safeguards: [{ type: 'dangerous_tool_use' }] }), true)
})

test('工具调用流把判定结果放进 message_delta', async () => {
  const events = []
  const calls = []
  const summary = await translateStream(sse(toolFrames), {
    model: 'test-model',
    inputTokens: 10,
    emit: (event, data) => events.push({ event, data }),
    safeguard: async (received) => {
      calls.push(received)
      return notFlagged
    },
  })
  assert.deepEqual(calls, [[{ id: 'call_1', name: 'Bash', input: { command: 'ls' } }]])
  const messageDelta = events.find((entry) => entry.event === 'message_delta').data
  assert.deepEqual(messageDelta.delta.safeguard_results, notFlagged)
  assert.equal(summary.toolUses.length, 1)
  const order = events.map((entry) => entry.event)
  assert.ok(order.indexOf('message_delta') > order.lastIndexOf('content_block_stop'))
  assert.ok(order.indexOf('message_delta') < order.indexOf('message_stop'))
})

test('没有判定请求时不输出 safeguard_results 字段', async () => {
  const events = []
  await translateStream(sse(toolFrames), {
    model: 'test-model',
    inputTokens: 10,
    emit: (event, data) => events.push({ event, data }),
  })
  const messageDelta = events.find((entry) => entry.event === 'message_delta').data
  assert.equal('safeguard_results' in messageDelta.delta, false)
})

test('非流式响应把判定结果放在顶层', async () => {
  const message = await collectMessage(sse(toolFrames), {
    model: 'test-model',
    inputTokens: 10,
    emit: () => {},
    safeguard: async () => notFlagged,
  })
  assert.deepEqual(message.safeguard_results, notFlagged)
  assert.equal(message.content[0].type, 'tool_use')
})

test('分类调用把工具调用转成协议结果', async () => {
  const mock = installFetch(
    '{"verdicts":[{"id":"call_1","outcome":"not_flagged","reason":"只读命令"}]}',
  )
  try {
    const results = await classifyToolUses({
      credential,
      request: {
        ...request,
        safeguards: [...request.safeguards, { type: 'other', scaffold: 'x' }],
      },
      toolUses,
      model: 'test-model',
      originRequest: {
        ...request,
        safeguards: [...request.safeguards, { type: 'other', scaffold: 'x' }],
      },
    })
    assert.deepEqual(results, notFlagged)
    assert.equal(mock.sent.length, 1)
    assert.equal(mock.sent[0].body.model, 'test-model')
    assert.equal(mock.sent[0].body.tools, undefined)
    assert.deepEqual(mock.sent[0].body.safeguards, [{ type: 'other', scaffold: 'x' }])
    const prompt = mock.sent[0].body.messages[1].content
    assert.match(prompt, /<pending_tool_calls>/u)
    assert.match(prompt, /call_1/u)
    assert.match(prompt, /permission_mode/u)
  } finally {
    mock.restore()
  }
})

test('判为危险时带上解释，且允许代码块包裹', async () => {
  const mock = installFetch(
    '```json\n{"verdicts":[{"id":"call_1","outcome":"flagged","reason":"递归删除整个目录"}]}\n```',
  )
  try {
    const results = await classifyToolUses({ credential, request, toolUses, model: 'test-model' })
    assert.deepEqual(results[0].status.tool_uses.call_1, {
      type: 'evaluated',
      outcome: 'flagged',
      explanation: '递归删除整个目录',
    })
  } finally {
    mock.restore()
  }
})

test('分类输出无法解析时抛错，由调用方 fail-closed', async () => {
  const mock = installFetch('这个命令看起来没问题')
  try {
    await assert.rejects(
      () => classifyToolUses({ credential, request, toolUses, model: 'test-model' }),
      /JSON 判定/u,
    )
    assert.deepEqual(unavailableSafeguardResults(), [
      { type: 'dangerous_tool_use', status: { type: 'unavailable' } },
    ])
  } finally {
    mock.restore()
  }
})

test('缺少某个工具调用的判定时不能当作放行', () => {
  assert.throws(() => parseVerdicts('{"verdicts":[]}', toolUses), /缺少工具调用 call_1/u)
  assert.throws(
    () => parseVerdicts('{"verdicts":[{"id":"call_1","outcome":"ok"}]}', toolUses),
    /缺少工具调用 call_1/u,
  )
})

test('缺少多个判定时一次列出全部 id', () => {
  const two = [...toolUses, { id: 'call_2', name: 'Bash', input: { command: 'pwd' } }]
  assert.throws(
    () => parseVerdicts('{"verdicts":[{"id":"call_1","outcome":"not_flagged"}]}', two),
    /call_2/u,
  )
})

test('JSON 前面的说明文字里带花括号也能解析', () => {
  const text = `The input {"command":"cat a | jq '{x}'"} looks safe.
{"verdicts":[{"id":"call_1","outcome":"not_flagged"}]}
Let me know if you need anything else {ok}`
  assert.deepEqual(parseVerdicts(text, toolUses), notFlagged)
})

test('调用方传入的 signal 中止时分类请求跟着放弃', async () => {
  const mock = installFetch('{"verdicts":[{"id":"call_1","outcome":"not_flagged"}]}')
  try {
    await assert.rejects(() =>
      classifyToolUses({
        credential,
        request,
        toolUses,
        model: 'test-model',
        originRequest: request,
        signal: AbortSignal.abort(),
      }),
    )
  } finally {
    mock.restore()
  }
})

test('outcome 大小写和空白不影响判定', () => {
  assert.deepEqual(
    parseVerdicts('{"verdicts":[{"id":"call_1","outcome":" Not_Flagged "}]}', toolUses),
    notFlagged,
  )
})

test('没有工具调用的回复也要回一个空裁决，不能是空数组', async () => {
  const textFrames = [
    {
      choices: [{ delta: { content: '好的' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ]
  const events = []
  await translateStream(sse(textFrames), {
    model: 'test-model',
    inputTokens: 0,
    emit: (event, data) => events.push({ event, data }),
    safeguard: async () => emptySafeguardResults(),
  })
  const delta = events.find((entry) => entry.event === 'message_delta').data.delta
  assert.deepEqual(delta.safeguard_results, [
    { type: 'dangerous_tool_use', status: { type: 'available', tool_uses: {} } },
  ])
})

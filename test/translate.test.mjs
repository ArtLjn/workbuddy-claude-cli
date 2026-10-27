import assert from 'node:assert/strict'
import test from 'node:test'
import { collectMessage, translateStream } from '../lib/anthropic.mjs'

async function* sse(frames) {
  for (const frame of frames) yield `data: ${JSON.stringify(frame)}\n\n`
  yield 'data: [DONE]\n\n'
}

async function run(frames, inputTokens = 10) {
  const events = []
  const summary = await translateStream(sse(frames), {
    model: 'test-model',
    inputTokens,
    emit: (event, data) => events.push({ event, data }),
  })
  return { events, summary }
}

function of(events, name) {
  return events.filter((entry) => entry.event === name).map((entry) => entry.data)
}

test('文本流翻译成 Anthropic SSE', async () => {
  const { events, summary } = await run([
    { choices: [{ delta: { content: 'Hel' }, finish_reason: '' }] },
    {
      choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    },
  ])
  assert.deepEqual(
    events.map((entry) => entry.event),
    [
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ],
  )
  const starts = of(events, 'content_block_start')
  assert.equal(starts[0].content_block.type, 'text')
  const deltas = of(events, 'content_block_delta')
  assert.equal(deltas.map((delta) => delta.delta.text).join(''), 'Hello')
  const messageDelta = of(events, 'message_delta')[0]
  assert.equal(messageDelta.delta.stop_reason, 'end_turn')
  assert.equal(messageDelta.usage.output_tokens, 5)
  assert.equal(summary.stopReason, 'end_turn')
})

test('工具调用流翻译成 tool_use 块并拼接参数', async () => {
  const { events, summary } = await run([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '' },
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
          delta: { tool_calls: [{ index: 0, function: { name: '', arguments: '{"city":' } }] },
          finish_reason: '',
        },
      ],
    },
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '"Beijing"}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    },
  ])
  const start = of(events, 'content_block_start')[0]
  assert.deepEqual(start.content_block, {
    type: 'tool_use',
    id: 'call_1',
    name: 'get_weather',
    input: {},
  })
  const partial = of(events, 'content_block_delta')
    .filter((delta) => delta.delta.type === 'input_json_delta')
    .map((delta) => delta.delta.partial_json)
    .join('')
  assert.equal(partial, '{"city":"Beijing"}')
  assert.equal(of(events, 'message_delta')[0].delta.stop_reason, 'tool_use')
  assert.equal(summary.stopReason, 'tool_use')
})

test('默认不输出 reasoning_content', async () => {
  const { events } = await run([
    {
      choices: [
        {
          delta: { reasoning_content: '内部思考', content: 'hi' },
          finish_reason: 'stop',
        },
      ],
    },
  ])
  assert.equal(
    of(events, 'content_block_start').some((block) => block.content_block.type === 'thinking'),
    false,
  )
  assert.equal(
    of(events, 'content_block_delta')
      .map((delta) => delta.delta.text)
      .join(''),
    'hi',
  )
})

test('空流也会产生一个空文本块', async () => {
  const { events } = await run([])
  const starts = of(events, 'content_block_start')
  assert.equal(starts.length, 1)
  assert.equal(starts[0].content_block.type, 'text')
  assert.equal(of(events, 'message_delta')[0].delta.stop_reason, 'end_turn')
})

test('collectMessage 合并文本事件', async () => {
  const message = await collectMessage(
    sse([
      {
        choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    ]),
    { model: 'test-model', inputTokens: 10, emit: () => {} },
  )
  assert.equal(message.type, 'message')
  assert.deepEqual(message.content, [{ type: 'text', text: 'Hello' }])
  assert.equal(message.stop_reason, 'end_turn')
  assert.equal(message.usage.output_tokens, 5)
})

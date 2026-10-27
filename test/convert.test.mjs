import assert from 'node:assert/strict'
import test from 'node:test'
import { toOpenAIChat } from '../lib/anthropic.mjs'
import { prepareChatBody } from '../lib/upstream.mjs'

test('Anthropic 请求转成 OpenAI：system、工具调用与工具结果', () => {
  const body = {
    model: 'workbuddy-model',
    max_tokens: 1000,
    system: [{ type: 'text', text: '系统提示', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: '北京天气？' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我查一下' },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Beijing' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '晴' }] },
        ],
      },
    ],
    tools: [
      {
        name: 'get_weather',
        description: '查天气',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ],
    tool_choice: { type: 'auto' },
    stop_sequences: ['END'],
    temperature: 0.2,
  }

  const openai = toOpenAIChat(body, 'workbuddy-model')
  assert.equal(openai.stream, true)
  assert.equal(openai.model, 'workbuddy-model')
  assert.deepEqual(openai.messages[0], { role: 'system', content: '系统提示' })
  assert.equal(openai.messages[1].content, '北京天气？')
  assert.equal(openai.messages[2].content, '我查一下')
  assert.deepEqual(openai.messages[2].tool_calls, [
    {
      id: 'toolu_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
    },
  ])
  assert.deepEqual(openai.messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: '晴' })
  assert.equal(openai.tools[0].function.name, 'get_weather')
  assert.equal(openai.tool_choice, 'auto')
  assert.deepEqual(openai.stop, ['END'])
  assert.equal(openai.temperature, 0.2)
})

test('图片与 any 工具选择正确转换', () => {
  const openai = toOpenAIChat(
    {
      model: 'm',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
            },
          ],
        },
      ],
      tools: [{ name: 't', input_schema: { type: 'object' } }],
      tool_choice: { type: 'any' },
    },
    'm',
  )
  assert.equal(openai.tool_choice, 'required')
  assert.equal(openai.messages[0].content[1].image_url.url, 'data:image/png;base64,AAAA')
})

test('指定工具选择转换成 OpenAI function 对象', () => {
  const openai = toOpenAIChat(
    {
      model: 'm',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'Read' },
    },
    'm',
  )
  assert.deepEqual(openai.tool_choice, { type: 'function', function: { name: 'Read' } })
})

test('身份清洗只动 system/assistant，不动用户文本', () => {
  const billing = 'x-anthropic-billing-header: cc_version=2.1.272; cc_entrypoint=sdk-cli;'
  const feedback = '- To give feedback, report at https://github.com/anthropics/claude-code/issues'
  const body = {
    stream: true,
    messages: [
      {
        role: 'system',
        content: `${billing}\nYou are Claude Code, Anthropic's official CLI for Claude.\n${feedback}`,
      },
      { role: 'user', content: `${billing}\n${feedback}` },
      { role: 'assistant', content: 'built on Anthropic Claude Code' },
    ],
  }
  const prepared = prepareChatBody(body, { rewriteIdentity: true })
  assert.equal(prepared.messages[0].content.includes('x-anthropic-billing-header'), false)
  assert.equal(prepared.messages[0].content.includes('official CLI for Claude'), false)
  assert.equal(prepared.messages[0].content.includes('github.com/anthropics'), false)
  assert.equal(prepared.messages[1].content, `${billing}\n${feedback}`)
  assert.equal(prepared.messages[2].content, 'built on Anthropic Claude Code')
})

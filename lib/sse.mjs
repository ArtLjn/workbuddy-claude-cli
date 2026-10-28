// 两种下游协议共用的上游 SSE 读取器，按事件边界解码，保留跨字节的中文。
export async function* readChatFrames(stream) {
  if (stream === null) throw new Error('上游响应缺少流')
  const decoder = new TextDecoder()
  let carry = ''
  let data = []
  const payload = () => {
    const text = data.join('\n').trim()
    data = []
    return text
  }
  async function* lines() {
    for await (const chunk of stream) {
      carry += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      let newline
      while ((newline = carry.indexOf('\n')) !== -1) {
        yield carry.slice(0, newline).replace(/\r$/u, '')
        carry = carry.slice(newline + 1)
      }
    }
    carry += decoder.decode()
    if (carry !== '') yield carry.replace(/\r$/u, '')
    yield ''
  }
  for await (const line of lines()) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''))
    if (line !== '' || data.length === 0) continue
    const text = payload()
    if (text === '[DONE]') return
    if (text === '') continue
    let frame
    try {
      frame = JSON.parse(text)
    } catch {
      throw new Error('上游 SSE 包含非法 JSON')
    }
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
      throw new Error('上游 SSE 帧必须是 JSON 对象')
    }
    if (frame.error) throw new Error(frame.error.message ?? JSON.stringify(frame.error))
    yield frame
  }
}

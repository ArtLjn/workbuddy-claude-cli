import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../server.mjs', import.meta.url))

function run(env, ...args) {
  const child = spawn(process.execPath, [entry, ...args], { env })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const done = once(child, 'close').then(([code]) => ({ code, stdout, stderr }))
  return { child, done, output: () => stdout + stderr }
}

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

async function freePort() {
  const server = createServer()
  const port = await listen(server)
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'wcc-test-'))
  const port = await freePort()
  const env = {
    ...process.env,
    WORKBUDDY_PROXY_HOST: '127.0.0.1',
    WORKBUDDY_PROXY_PORT: String(port),
    WORKBUDDY_CLAUDE_HOME: directory,
    WORKBUDDY_AUTH_FILE: join(directory, 'missing-auth.json'),
    WORKBUDDY_PROXY_TOKEN: '',
  }
  const children = []
  t.after(async () => {
    for (const server of children) {
      if (server.child.exitCode === null) server.child.kill('SIGTERM')
      await server.done
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  return {
    env,
    port,
    statePath: join(directory, `service-${port}.json`),
    async start(command = 'start') {
      const server = run(env, ...(command === '' ? [] : [command]))
      children.push(server)
      for (let attempt = 0; attempt < 400; attempt++) {
        if (server.output().includes('监听 http://')) return server
        if (server.child.exitCode !== null) assert.fail(server.output())
        await setTimeout(25)
      }
      assert.fail(`等待服务启动超时：${server.output()}`)
    },
  }
}

function http(port, { path = '/health', method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode))
      res.on('error', reject)
    })
    req.setTimeout(5000, () => req.destroy(new Error('测试请求超时')))
    req.on('error', reject)
    req.end()
  })
}

test('默认启动、控制令牌校验、CLI 停止和重复停止', { timeout: 20_000 }, async (t) => {
  const app = await fixture(t)
  app.env.WORKBUDDY_PROXY_TOKEN = 'test-proxy-token'
  const server = await app.start('')
  const state = JSON.parse(await readFile(app.statePath, 'utf8'))
  assert.equal(state.port, app.port)
  if (process.platform !== 'win32') assert.equal((await stat(app.statePath)).mode & 0o777, 0o600)
  const options = { path: '/_wcc/stop', method: 'POST' }
  assert.equal(
    await http(app.port, { ...options, headers: { Authorization: 'Bearer test-proxy-token' } }),
    403,
  )
  assert.equal(
    await http(app.port, { ...options, headers: { 'X-WCC-Stop-Token': 'wrong-token' } }),
    403,
  )
  assert.equal(
    await http(app.port, {
      ...options,
      headers: { 'X-WCC-Stop-Token': state.token, Origin: 'https://example.com' },
    }),
    403,
  )
  assert.equal(await http(app.port, { headers: { Authorization: 'Bearer test-proxy-token' } }), 200)
  const stopped = await run({ ...app.env, WORKBUDDY_PROXY_TOKEN: '' }, 'stop').done
  assert.equal(stopped.code, 0, stopped.stderr)
  assert.match(stopped.stdout, /代理已停止/u)
  assert.equal((await server.done).code, 0)
  await assert.rejects(stat(app.statePath), { code: 'ENOENT' })
  const repeated = await run(app.env, 'stop').done
  assert.equal(repeated.code, 0, repeated.stderr)
  assert.match(repeated.stdout, /未发现运行中的代理/u)
})

test('端口冲突不覆盖正在运行的实例状态', { timeout: 20_000 }, async (t) => {
  const app = await fixture(t)
  await app.start()
  const original = await readFile(app.statePath, 'utf8')
  const duplicate = await run(app.env, 'start').done
  assert.equal(duplicate.code, 1)
  assert.match(duplicate.stderr, /已被占用/u)
  assert.equal(await readFile(app.statePath, 'utf8'), original)
  assert.equal(await http(app.port), 200)
  assert.equal((await run(app.env, 'stop').done).code, 0)
})

test('残留状态只清理记录，无运行实例时停止也成功', { timeout: 10_000 }, async (t) => {
  const app = await fixture(t)
  await writeFile(
    app.statePath,
    JSON.stringify({
      version: 1,
      host: '127.0.0.1',
      port: app.port,
      token: randomBytes(32).toString('hex'),
    }),
  )
  const result = await run(app.env, 'stop').done
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /未发现运行中的代理/u)
  await assert.rejects(stat(app.statePath), { code: 'ENOENT' })
})

test('停止请求不会终止占据旧端口的其他 HTTP 服务', { timeout: 10_000 }, async (t) => {
  const app = await fixture(t)
  const unrelated = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  const port = await listen(unrelated)
  t.after(() => new Promise((resolve) => unrelated.close(resolve)))
  await writeFile(
    app.statePath,
    JSON.stringify({ version: 1, host: '127.0.0.1', port, token: randomBytes(32).toString('hex') }),
  )
  const result = await run(app.env, 'stop').done
  assert.equal(result.code, 1)
  assert.match(result.stderr, /代理拒绝停止请求/u)
  assert.equal(await http(port), 404)
  assert.ok(await stat(app.statePath))
})

test('无效状态和非本机地址不发送停止请求', { timeout: 10_000 }, async (t) => {
  const app = await fixture(t)
  for (const state of [
    null,
    { version: 1, host: 'example.com', port: 80, token: 'a'.repeat(64) },
  ]) {
    await writeFile(app.statePath, JSON.stringify(state))
    const result = await run(app.env, 'stop').done
    assert.equal(result.code, 1)
    assert.match(result.stderr, /运行状态格式无效/u)
  }
})

test(
  'POSIX 信号停止会清理运行状态',
  { skip: process.platform === 'win32', timeout: 15_000 },
  async (t) => {
    const app = await fixture(t)
    const server = await app.start()
    server.child.kill('SIGTERM')
    assert.equal((await server.done).code, 0)
    await assert.rejects(stat(app.statePath), { code: 'ENOENT' })
  },
)

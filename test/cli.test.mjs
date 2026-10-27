import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../server.mjs', import.meta.url))
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function run(...args) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8', timeout: 5000 })
}

test('CLI 帮助不启动服务', () => {
  const result = run('--help')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /workbuddy-claude-cli \[start\|check\|env/u)
})

test('CLI 版本与发布包一致', () => {
  const result = run('--version')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), metadata.version)
})

test('CLI 新旧环境变量命令兼容', () => {
  const current = run('env')
  const legacy = run('--print-env')
  assert.equal(current.status, 0, current.stderr)
  assert.equal(legacy.status, 0, legacy.stderr)
  assert.equal(current.stdout, legacy.stdout)
  assert.match(current.stdout, /export ANTHROPIC_BASE_URL=/u)
  assert.match(current.stdout, /export ANTHROPIC_DEFAULT_HAIKU_MODEL=/u)
})

test('CLI 拒绝未知命令和多余参数，避免意外启动服务', () => {
  for (const args of [['strat'], ['start', '--unknown']]) {
    const result = run(...args)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /--help/u)
    assert.equal(result.stdout, '')
  }
})

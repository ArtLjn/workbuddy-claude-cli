// 通过本机控制令牌停止代理，不按端口或 PID 杀进程。
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { config } from './config.mjs'

export const STOP_PATH = '/_wcc/stop'
const statePath = join(config.stateDir, `service-${config.port}.json`)

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new Error('无法读取代理运行状态', { cause: error })
  }
}

/** 仅在成功监听后保存状态，端口冲突的进程不会覆盖现有实例。 */
export async function registerService(address, token) {
  const host =
    address.address === '0.0.0.0' ? '127.0.0.1' : address.address === '::' ? '::1' : address.address
  const state = { version: 1, host, port: address.port, token }
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 })
  const temporary = `${statePath}.${process.pid}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    await rename(temporary, statePath)
    await chmod(statePath, 0o600)
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

/** 只清理本实例的状态，避免删掉新实例写入的控制令牌。 */
export async function unregisterService(token) {
  const state = await readState()
  if (state?.token === token) {
    await unlink(statePath).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

function requestStop(state) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: state.host,
        port: state.port,
        path: STOP_PATH,
        method: 'POST',
        headers: { 'X-WCC-Stop-Token': state.token },
        agent: false,
      },
      (res) => {
        res.resume()
        res.on('end', () => {
          if (res.statusCode === 200) resolve()
          else reject(new Error(`代理拒绝停止请求（HTTP ${res.statusCode}），未停止任何其他进程`))
        })
        res.on('error', reject)
      },
    )
    req.setTimeout(5000, () => req.destroy(new Error('停止代理超时')))
    req.on('error', reject)
    req.end()
  })
}

/** 重复停止可安全执行；失效记录只清理状态，不给任何 PID 发信号。 */
export async function stopService() {
  const state = await readState()
  if (state === undefined) return false
  if (
    state === null ||
    typeof state !== 'object' ||
    state.version !== 1 ||
    !['127.0.0.1', '::1', 'localhost'].includes(state.host) ||
    !Number.isInteger(state.port) ||
    state.port < 1 ||
    state.port > 65535 ||
    typeof state.token !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(state.token)
  ) {
    throw new Error('代理运行状态格式无效，未发送停止请求')
  }
  try {
    await requestStop(state)
  } catch (error) {
    if (error.code !== 'ECONNREFUSED') throw error
    await unregisterService(state.token)
    return false
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await readState())?.token !== state.token) return true
    await setTimeout(50)
  }
  throw new Error('停止请求已发送，但未能确认代理已退出')
}

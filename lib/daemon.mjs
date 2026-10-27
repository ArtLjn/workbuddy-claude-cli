// 启动脱离终端的代理进程，通过 IPC 确认监听成功后再返回。
import { spawn } from 'node:child_process'
import { chmod, mkdir, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { config } from './config.mjs'

export async function startBackground(entry) {
  const stateDir = resolve(config.stateDir)
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const logPath = join(stateDir, `proxy-${config.port}.log`)
  const logFile = await open(logPath, 'a', 0o600)
  try {
    await chmod(logPath, 0o600)
    const child = spawn(process.execPath, [entry, '--foreground'], {
      detached: true,
      windowsHide: true,
      cwd: stateDir,
      env: {
        ...process.env,
        WORKBUDDY_CLAUDE_HOME: stateDir,
        WORKBUDDY_AUTH_FILE: config.authFile === '' ? '' : resolve(config.authFile),
        WORKBUDDY_DUMP_REQUEST: config.dumpRequest === '' ? '' : resolve(config.dumpRequest),
      },
      stdio: ['ignore', logFile.fd, logFile.fd, 'ipc'],
    })
    const address = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('等待后台代理启动超时')), 15_000)
      const onError = (error) => finish(error)
      const onExit = (code, signal) => {
        finish(new Error(`后台代理启动失败（${signal ?? code}），详见 ${logPath}`))
      }
      const onMessage = (message) => {
        if (message?.type === 'wcc-ready') finish(undefined, message)
        else if (message?.type === 'wcc-error') finish(new Error(message.message))
      }
      function finish(error, result) {
        clearTimeout(timer)
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
        child.removeListener('message', onMessage)
        if (error && child.pid !== undefined && child.exitCode === null) child.kill()
        if (child.connected) child.disconnect()
        child.unref()
        if (error) reject(error)
        else resolve(result)
      }
      child.once('error', onError)
      child.once('exit', onExit)
      child.on('message', onMessage)
    })
    return { ...address, logPath }
  } finally {
    await logFile.close()
  }
}

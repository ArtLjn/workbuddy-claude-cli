// 解析 WorkBuddy 桌面 App 的版本，构造聊天请求需要的 User-Agent。
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { VARIANT, debugLog } from './config.mjs'

const FALLBACK_VERSION = { cn: '5.5.6', global: '5.5.2' }

function validVersion(value) {
  return typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}$/u.test(value)
}

function validCliVersion(value) {
  return typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/u.test(value)
}

function appRoots() {
  return ['/Applications', join(homedir(), 'Applications')]
}

/** 从 Info.plist 读取 CFBundleShortVersionString。 */
async function readBundleVersion(plistPath) {
  let text
  try {
    text = await readFile(plistPath, 'utf8')
  } catch {
    return undefined
  }
  const match = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(
    text,
  )
  const version = match?.[1]?.trim()
  return validVersion(version) ? version : undefined
}

/** 读取 App 内置 CLI 的真实版本；读不到时省略 UA 的 CLI 段。 */
async function readCliVersion(bundle) {
  const path = join(bundle, 'Contents', 'Resources', 'app.asar.unpacked', 'cli', 'package.json')
  let document
  try {
    document = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof document !== 'object' || document === null) return undefined
  const declared = document.version
  if (validCliVersion(declared) && declared !== '0.0.0') return declared
  const custom = document.publishConfig?.customPackage?.version
  return validCliVersion(custom) ? custom : undefined
}

async function installedIdentity() {
  if (process.platform !== 'darwin') return undefined
  const appName = VARIANT === 'global' ? 'WorkBuddy AI.app' : 'WorkBuddy.app'
  for (const root of appRoots()) {
    const bundle = join(root, appName)
    const version = await readBundleVersion(join(bundle, 'Contents', 'Info.plist'))
    if (version !== undefined) {
      return { clientVersion: version, cliVersion: await readCliVersion(bundle) }
    }
  }
  return undefined
}

let cached

/** 当前进程的聊天身份：已安装 App → 内置兜底版本。 */
export async function currentIdentity() {
  if (cached !== undefined) return cached
  let resolved
  try {
    resolved = await installedIdentity()
  } catch (error) {
    debugLog('读取 App 版本失败:', String(error))
  }
  cached = resolved ?? { clientVersion: FALLBACK_VERSION[VARIANT] }
  return cached
}

/** 官方桌面客户端的 UA 形状；CLI 段只在能读出版本时才出现。 */
export function chatUserAgent(identity) {
  const product = VARIANT === 'global' ? 'WorkBuddy AI' : 'WorkBuddy'
  const parts = [`WorkBuddy/${identity.clientVersion}`, `${product}/${identity.clientVersion}`]
  if (identity.cliVersion !== undefined) parts.push(`CLI/${identity.cliVersion}`)
  return parts.join(' ')
}

/** 目录请求使用的 App 形 UA（国际版网关按这个形态分流）。 */
export function catalogUserAgent(identity) {
  return VARIANT === 'global'
    ? `WorkBuddyAI/${identity.clientVersion}`
    : 'CLI/2.63.2 CodeBuddy/2.63.2'
}

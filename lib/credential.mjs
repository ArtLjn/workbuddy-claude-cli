// 读取 WorkBuddy 桌面 App 的登录态，并在需要时刷新令牌。
// 桌面文件只读；刷新结果写到本代理自己的状态目录。
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { BASES, VARIANT, debugLog, desktopAuthCandidates, ownCredentialPath } from './config.mjs'

const REFRESH_MARGIN_MS = 5 * 60 * 1000
const REFRESH_TIMEOUT_MS = 30_000
const OWN_FORMAT_VERSION = 1

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 秒级与毫秒级时间戳都归一成毫秒。 */
function expiryToMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function regionOf(domain) {
  const lowered = domain.trim().toLowerCase()
  return lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai') ? 'global' : 'cn'
}

/** 解析桌面 App 的凭据文档（嵌套 auth.account 或扁平两种形状）。 */
export function parseCredentialDocument(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('WorkBuddy 凭据文件不是合法 JSON，请打开 WorkBuddy App 重新登录')
  }
  if (!isObject(parsed)) throw new Error('WorkBuddy 凭据文件格式无法识别')
  const nested = isObject(parsed.auth)
  const auth = nested ? parsed.auth : parsed
  const account = nested && isObject(parsed.account) ? parsed.account : parsed
  if (typeof auth.accessToken !== 'string' || auth.accessToken === '') {
    throw new Error(
      'WorkBuddy 凭据文件里没有 accessToken（可能是 5.6+ 的加密格式，或尚未登录）；' +
        '请打开 WorkBuddy App 登录后再试',
    )
  }
  return {
    accessToken: auth.accessToken,
    refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : '',
    expiresAtMs: expiryToMs(auth.expiresAt),
    refreshExpiresAtMs:
      auth.refreshExpiresAt === undefined ? undefined : expiryToMs(auth.refreshExpiresAt),
    domain: optionalString(auth.domain) ?? '',
    uid: optionalString(account.uid) ?? '',
    enterpriseId: optionalString(account.enterpriseId),
    nickname: optionalString(account.nickname),
    source: 'desktop',
  }
}

/** 读取桌面 App 的凭据；候选文件都不存在时返回 undefined。 */
async function readDesktopCredential() {
  for (const path of desktopAuthCandidates()) {
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (text.trim() === '') continue
    const credential = parseCredentialDocument(text)
    credential.desktopPath = path
    return credential
  }
  return undefined
}

/** 读取本代理保存的刷新副本。 */
async function readOwnCredential() {
  let text
  try {
    text = await readFile(ownCredentialPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    return undefined
  }
  try {
    const parsed = JSON.parse(text)
    if (!isObject(parsed) || parsed.version !== OWN_FORMAT_VERSION) return undefined
    const stored = parsed.credential
    if (!isObject(stored) || typeof stored.accessToken !== 'string' || stored.accessToken === '') {
      return undefined
    }
    return {
      accessToken: stored.accessToken,
      refreshToken: typeof stored.refreshToken === 'string' ? stored.refreshToken : '',
      expiresAtMs: expiryToMs(stored.expiresAtMs),
      refreshExpiresAtMs:
        stored.refreshExpiresAtMs === undefined ? undefined : expiryToMs(stored.refreshExpiresAtMs),
      domain: optionalString(stored.domain) ?? '',
      uid: optionalString(stored.uid) ?? '',
      enterpriseId: optionalString(stored.enterpriseId),
      nickname: optionalString(stored.nickname),
      source: 'own',
    }
  } catch {
    return undefined
  }
}

/** 原子写入刷新副本，权限 0600。 */
async function saveOwnCredential(credential) {
  await mkdir(dirname(ownCredentialPath), { recursive: true, mode: 0o700 })
  const document = { version: OWN_FORMAT_VERSION, credential }
  const temporary = `${ownCredentialPath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, ownCredentialPath)
  await chmod(ownCredentialPath, 0o600).catch(() => {})
}

/** 两侧凭据都校验地区，避免把国内令牌发到国际端点。 */
function assertRegion(credential, label) {
  if (credential === undefined) return
  const actual = regionOf(credential.domain)
  if (actual !== VARIANT) {
    throw new Error(
      `WorkBuddy 凭据地区不匹配：${label} 属于 ${actual}，当前代理按 ${VARIANT} 运行；` +
        '请设置 WORKBUDDY_REGION 或指向正确的登录文件',
    )
  }
}

/** 取最新凭据：桌面文件是账号权威，同一账号时才比较过期时间。 */
export async function currentCredential() {
  const [desktop, own] = await Promise.all([readDesktopCredential(), readOwnCredential()])
  assertRegion(desktop, '桌面登录文件')
  assertRegion(own, '代理刷新副本')
  if (desktop === undefined) return own
  if (own === undefined) return desktop
  if (desktop.uid !== own.uid || desktop.enterpriseId !== own.enterpriseId) return desktop
  return own.expiresAtMs > desktop.expiresAtMs ? own : desktop
}

function needsRefresh(credential) {
  if (credential.expiresAtMs <= 0) return true
  return Date.now() + REFRESH_MARGIN_MS >= credential.expiresAtMs
}

async function refreshToken(credential) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: BASES.origin,
    Referer: `${BASES.origin}/`,
    'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  const response = await fetch(`${BASES.chat}/v2/plugin/auth/token/refresh`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`刷新令牌返回非 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`)
  }
  const code = isObject(parsed) && typeof parsed.code === 'number' ? parsed.code : 0
  if (!response.ok || code !== 0) {
    const msg = isObject(parsed) && typeof parsed.msg === 'string' ? parsed.msg : text.slice(0, 160)
    throw new Error(`刷新令牌失败（HTTP ${response.status} / code ${code}）：${msg}`)
  }
  const data = isObject(parsed) && isObject(parsed.data) ? parsed.data : {}
  if (typeof data.accessToken !== 'string' || data.accessToken === '') {
    throw new Error('刷新令牌未返回 accessToken；请打开 WorkBuddy App 重新登录')
  }
  return {
    accessToken: data.accessToken,
    refreshToken:
      typeof data.refreshToken === 'string' && data.refreshToken !== ''
        ? data.refreshToken
        : credential.refreshToken,
    expiresAtMs:
      typeof data.expiresIn === 'number' && data.expiresIn > 0
        ? Date.now() + data.expiresIn * 1000
        : credential.expiresAtMs,
    domain: typeof data.domain === 'string' && data.domain !== '' ? data.domain : credential.domain,
  }
}

let inflightRefresh

async function refreshNow(credential) {
  if (credential.refreshToken === '') {
    if (credential.expiresAtMs > Date.now() + 30_000) return credential
    throw new Error(
      'WorkBuddy access token 已过期且没有 refreshToken；请打开 WorkBuddy App 重新登录',
    )
  }
  try {
    const outcome = await refreshToken(credential)
    const refreshed = { ...credential, ...outcome, source: 'own' }
    await saveOwnCredential(refreshed)
    debugLog('令牌已刷新，过期时间', new Date(refreshed.expiresAtMs).toISOString())
    return refreshed
  } catch (error) {
    if (credential.expiresAtMs > Date.now() + 30_000) {
      debugLog('刷新失败，但当前令牌仍有效，继续使用:', String(error))
      return credential
    }
    throw new Error(
      `WorkBuddy 令牌刷新失败且当前令牌已过期（${String(error)}）；请打开 WorkBuddy App 重新登录`,
      { cause: error },
    )
  }
}

/** 供请求使用的凭据：必要时单飞刷新。 */
export async function resolveCredential() {
  const credential = await currentCredential()
  if (credential === undefined) {
    throw new Error(
      '没有找到已登录的 WorkBuddy 账号；请先打开 WorkBuddy 桌面 App 登录，' +
        `或设置 WORKBUDDY_AUTH_FILE（当前探测：${desktopAuthCandidates().join(' 或 ')}）`,
    )
  }
  if (!needsRefresh(credential)) return credential
  inflightRefresh ??= refreshNow(credential).finally(() => {
    inflightRefresh = undefined
  })
  return inflightRefresh
}

/** 登录状态摘要，不抛异常。 */
export async function credentialStatus() {
  try {
    const credential = await currentCredential()
    if (credential === undefined) return { state: 'signed-out' }
    return {
      state: 'signed-in',
      nickname: credential.nickname,
      uid: credential.uid,
      domain: credential.domain,
      source: credential.source,
      expiresAtMs: credential.expiresAtMs,
    }
  } catch (error) {
    return { state: 'signed-out', reason: String(error) }
  }
}

// 运行时配置：环境变量、WorkBuddy 凭据位置、上游地址。
import { homedir } from 'node:os'
import { join } from 'node:path'

const env = process.env

/** cn = 国内版 WorkBuddy；global = 国际版 WorkBuddy AI。 */
export const VARIANT = env.WORKBUDDY_REGION?.trim().toLowerCase() === 'global' ? 'global' : 'cn'

export const config = Object.freeze({
  host: env.WORKBUDDY_PROXY_HOST?.trim() || '127.0.0.1',
  port: Number(env.WORKBUDDY_PROXY_PORT ?? 3456),
  /** 显式指定桌面 App 凭据文件；留空时按平台默认位置探测。 */
  authFile: env.WORKBUDDY_AUTH_FILE?.trim() || '',
  /** 本代理自己的状态目录（刷新后的凭据副本）。 */
  stateDir: env.WORKBUDDY_CLAUDE_HOME?.trim() || join(homedir(), '.workbuddy-claude'),
  /** 请求里的模型不是 WorkBuddy 模型 id 时使用的兜底模型。 */
  defaultModel: env.WORKBUDDY_DEFAULT_MODEL?.trim() || 'deepseek-v4.1-flash',
  /** 固定发送的 reasoning_effort；留空表示不干预。 */
  reasoningEffort: env.WORKBUDDY_REASONING_EFFORT?.trim() || '',
  /** 可选的本机代理令牌；设置后客户端必须带同样的 Bearer。 */
  proxyToken: env.WORKBUDDY_PROXY_TOKEN?.trim() || '',
  /** 是否改写 Claude Code 身份句以通过网关渠道校验，默认开启。 */
  rewriteIdentity: env.WORKBUDDY_REWRITE_CLIENT_IDENTITY !== '0',
  /** 是否把上游 reasoning_content 作为 thinking 块返回，默认关闭。 */
  showReasoning: env.WORKBUDDY_SHOW_REASONING === '1',
  /** 是否响应 Claude Code auto 模式的服务端安全判定，默认开启。 */
  safeguards: env.WORKBUDDY_SAFEGUARDS !== '0',
  /** 安全判定使用的上游模型；留空表示沿用当前请求映射后的模型。 */
  safeguardModel: env.WORKBUDDY_SAFEGUARDS_MODEL?.trim() || '',
  /** 单次安全判定的超时时间，超时按 fail-closed 处理。 */
  safeguardTimeoutMs: Number(env.WORKBUDDY_SAFEGUARDS_TIMEOUT_MS ?? 60_000),
  debug: env.WORKBUDDY_DEBUG === '1',
  /** 调试用：把最终发往上游的请求体写到指定文件（含用户内容）。 */
  dumpRequest: env.WORKBUDDY_DUMP_REQUEST?.trim() || '',
  requestTimeoutMs: Number(env.WORKBUDDY_REQUEST_TIMEOUT_MS ?? 600_000),
})

export const BASES =
  VARIANT === 'global'
    ? Object.freeze({ chat: 'https://www.workbuddy.ai', origin: 'https://www.workbuddy.ai' })
    : Object.freeze({ chat: 'https://copilot.tencent.com', origin: 'https://www.codebuddy.cn' })

/** 需要请求的上游版本目录；两版共用同一目录、不同文件名。 */
const AUTH_DIR = ['CodeBuddyExtension', 'Data', 'Public', 'auth']

/** 桌面 App 凭据文件候选，按探测顺序返回。 */
export function desktopAuthCandidates() {
  if (config.authFile !== '') return [config.authFile]
  const filename = VARIANT === 'global' ? 'workbuddy-desktop-ai.info' : 'workbuddy-desktop.info'
  const home = homedir()
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', ...AUTH_DIR, filename)]
  }
  if (process.platform === 'win32') {
    return [
      join(home, 'AppData', 'Local', ...AUTH_DIR, filename),
      join(home, 'AppData', 'Roaming', ...AUTH_DIR, filename),
    ]
  }
  const configHome = env.XDG_CONFIG_HOME?.startsWith('/')
    ? env.XDG_CONFIG_HOME
    : join(home, '.config')
  const dataHome = env.XDG_DATA_HOME?.startsWith('/')
    ? env.XDG_DATA_HOME
    : join(home, '.local', 'share')
  return [join(configHome, ...AUTH_DIR, filename), join(dataHome, ...AUTH_DIR, filename)]
}

/** 本代理保存刷新后凭据的位置；不写 WorkBuddy 自己的文件。 */
export const ownCredentialPath = join(
  config.stateDir,
  VARIANT === 'global' ? 'credential-ai.json' : 'credential.json',
)

/** 一行诊断日志；debug 日志只在 WORKBUDDY_DEBUG=1 时输出。 */
export function log(...args) {
  console.log('[workbuddy-claude]', ...args)
}

export function debugLog(...args) {
  if (config.debug) console.log('[workbuddy-claude:debug]', ...args)
}

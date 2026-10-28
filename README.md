# workbuddy-claude-cli

**支持 Claude CLI（Claude Code）、Hermes Agent 接入 WorkBuddy 模型。** 使用
`wcc` 启动本地 Anthropic Messages / OpenAI Chat Completions 兼容代理，复用 WorkBuddy 桌面 App 登录态。

原理：Claude Code 说 Anthropic Messages API，WorkBuddy 上游说 OpenAI Chat Completions。
本代理在 `127.0.0.1` 上翻译 Anthropic 请求，或直接接收 Hermes 等客户端的 OpenAI 请求，复用 WorkBuddy 桌面 App 的登录态，
不改 Claude Code 本体，也不依赖 DSH。

## 前置

- Node.js ≥ 22（`node -v`）
- 已安装并登录 WorkBuddy 桌面 App（国内版默认；国际版见 `WORKBUDDY_REGION`）
- 已安装要使用的 Claude CLI（Claude Code）或 Hermes Agent；本包不包含客户端本体
- 运行时只用 Node 内置模块，无第三方运行依赖，也不需要 DSH

## 一条命令安装

```sh
npm install -g workbuddy-claude-cli
```

安装后启动：

```sh
wcc
# 或 wcc start
```

也可以免全局安装直接运行：

```sh
npx workbuddy-claude-cli
```

默认监听 `http://127.0.0.1:3456`。`wcc` / `wcc start` 默认后台运行，启动成功后立即返回，
可以关闭终端。这个地址提供 API，不是网页界面。升级到新版也使用同一条安装命令。

停止后台代理：

```sh
wcc stop
```

启动时会打印日志路径，默认是 `~/.workbuddy-claude/proxy-3456.log`。
如果需要在终端直接查看日志，可以前台运行：

```sh
wcc --foreground
# 或 wcc start --foreground，按 Ctrl+C 停止
```

后台运行不等于开机自启，重启电脑后需要重新执行 `wcc`。

## CLI 命令

```sh
wcc start       # 后台启动，直接运行 wcc 也可，启动后可关闭终端
wcc stop        # 停止代理，未运行时正常提示
wcc check       # 登录状态与当前可用模型
wcc env         # 打印 Claude CLI 环境变量示例
wcc env-openai  # 打印 OpenAI 环境变量及 Hermes 启动示例
wcc --version   # 版本号
wcc --help      # 帮助
wcc --foreground  # 前台运行，按 Ctrl+C 停止
```

原来的长命令 `workbuddy-claude-cli` 以及 `--check`、`--status`、`--print-env` 参数仍然可用；
例如 `workbuddy-claude-cli stop` 等同于 `wcc stop`。

如果启动时设置了 `WORKBUDDY_PROXY_PORT` 或 `WORKBUDDY_CLAUDE_HOME`，停止时也要使用相同的值。
停止不会退出 WorkBuddy App 或删除登录凭据。已有旧版代理运行时，请先用 `wcc stop` 或原终端的
`Ctrl+C` 关闭，再用新版 `wcc` 后台启动。

## 从源码启动

```sh
git clone https://github.com/ArtLjn/workbuddy-claude-cli.git
cd workbuddy-claude-cli
node server.mjs
```

源码启动无需安装依赖；在原 `dsh-workbuddy-bridge` 仓库中仍可执行 `node claude-cli/server.mjs`。

## 接入 Claude CLI（Claude Code）

先运行 `wcc check` 选择当前账号可用的模型 id。下面的例子使用默认模型
`deepseek-v4.1-flash`，也可以替换成列表中的其他模型。

### 方式一：macOS / Linux，只对当前终端生效

先运行 `wcc` 启动后台代理，再在终端执行：

```sh
export ANTHROPIC_BASE_URL="http://127.0.0.1:3456"
export ANTHROPIC_AUTH_TOKEN="workbuddy-local"
export ANTHROPIC_MODEL="deepseek-v4.1-flash"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$ANTHROPIC_MODEL"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$ANTHROPIC_MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$ANTHROPIC_MODEL"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"

claude
```

### 方式二：项目级配置（也适用于 Windows）

在项目的 `.claude/settings.local.json` 里写：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3456",
    "ANTHROPIC_AUTH_TOKEN": "workbuddy-local",
    "ANTHROPIC_MODEL": "deepseek-v4.1-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4.1-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4.1-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4.1-flash",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

> Claude Code 的 settings `env` 会覆盖 shell 里的同名变量。如果全局
> `~/.claude/settings.json` 已经指向别的服务（例如 DeepSeek），要么用单独的
> `CLAUDE_CONFIG_DIR`，要么把上面的值写进项目级配置。

> **`_MODEL` 和 `_MODEL_NAME` 不是一回事**：`ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME`
> 只是显示名称，不会改变实际模型 id。要让 `/model` 里选 Haiku 4.5 时真正走
> WorkBuddy，必须设置 `ANTHROPIC_DEFAULT_HAIKU_MODEL`（不带 `_NAME`）；
> Sonnet / Opus / Fable 同理。

### 方式三：完全隔离的配置目录

```sh
CLAUDE_CONFIG_DIR="$HOME/.claude-workbuddy" claude
```

把上面的 `env` 写进 `$CLAUDE_CONFIG_DIR/settings.json` 即可；这样不会影响现有
DeepSeek 配置。

## 接入 Hermes Agent（OpenAI 兼容端点）

Hermes 使用 OpenAI Chat Completions 协议，API Base URL 必须带 `/v1`。
`0.4.0` 起提供此端点。升级后先运行 `wcc stop`，再运行 `wcc`，让新代理生效。

```sh
# 启动已安装的代理
wcc

export OPENAI_BASE_URL="http://127.0.0.1:3456/v1"
export OPENAI_API_KEY="workbuddy-local"
export OPENAI_MODEL="deepseek-v4.1-flash"
export CUSTOM_BASE_URL="$OPENAI_BASE_URL"
hermes chat --provider custom --model "$OPENAI_MODEL"
```

`wcc env-openai` 可打印同样的配置示例。模型 id 从 `wcc check`
或 `/v1/models` 查询；OpenAI 端点遇到未知模型会返回 404，避免静默切换模型。
如果代理设置了 `WORKBUDDY_PROXY_TOKEN`，把 `OPENAI_API_KEY` 换成相同值。

要持久保存，运行 `hermes model`，选择 Custom endpoint，填写地址、密钥占位值和模型 id。
也可以在 `~/.hermes/config.yaml` 的现有配置里合并下面的模型段：

```yaml
model:
  provider: custom
  default: deepseek-v4.1-flash
  base_url: http://127.0.0.1:3456/v1
  api_mode: chat_completions
```

密钥通过 `OPENAI_API_KEY` 提供，或在 Hermes 的配置向导中保存。
已有自定义 provider 时，优先用 `hermes model` 选择，避免旧配置覆盖环境变量。
新版本 Hermes 的 `custom` 路由通过 `CUSTOM_BASE_URL` 或已保存的 `model.base_url`
选择端点；仅设置 `OPENAI_BASE_URL` 可能不会切换路由，所以示例同时设置两个变量。
协议选择 `chat_completions`；当前不提供 `/v1/responses`。
Hermes 配置机制见[官方接入文档](https://hermes-agent.nousresearch.com/docs/integrations/providers)。

OpenAI 路径支持流式与非流式、函数工具调用及工具结果回传、图片 `image_url`、
`reasoning_content` 和 token 用量。工具是否可用取决于所选模型；命令执行权限由 Hermes 管理。

## 代理环境变量

| 变量                                | 默认值                | 说明                                                                      |
| ----------------------------------- | --------------------- | ------------------------------------------------------------------------- |
| `WORKBUDDY_REGION`                  | `cn`                  | `cn` = WorkBuddy 国内版；`global` = WorkBuddy AI 国际版                   |
| `WORKBUDDY_AUTH_FILE`               | 平台默认              | 桌面 App 凭据文件路径；留空自动探测                                       |
| `WORKBUDDY_PROXY_HOST`              | `127.0.0.1`           | 监听地址；不建议改成 0.0.0.0                                              |
| `WORKBUDDY_PROXY_PORT`              | `3456`                | 监听端口                                                                  |
| `WORKBUDDY_DEFAULT_MODEL`           | `deepseek-v4.1-flash` | 请求模型不是 WorkBuddy id（如 `claude-*`）时使用的兜底模型                |
| `WORKBUDDY_REASONING_EFFORT`        | 空                    | 固定发送 `low`/`medium`/`high`/`xhigh`/`max`；空表示不干预                |
| `WORKBUDDY_PROXY_TOKEN`             | 空                    | 设置后客户端必须带相同的 Bearer/`x-api-key`                               |
| `WORKBUDDY_CLAUDE_HOME`             | `~/.workbuddy-claude` | 刷新后凭据副本目录（权限 0600）                                           |
| `WORKBUDDY_REWRITE_CLIENT_IDENTITY` | `1`                   | 设为 `0` 关闭客户端身份清洗（关闭后 Claude Code 会被 WorkBuddy 网关拦截） |
| `WORKBUDDY_SHOW_REASONING`          | `0`                   | 设为 `1` 把上游 `reasoning_content` 作为 thinking 块返回                  |
| `WORKBUDDY_SAFEGUARDS`              | `1`                   | 是否响应 auto 模式的服务端安全判定；`0` 关闭后 auto 模式在代理下不可用    |
| `WORKBUDDY_SAFEGUARDS_MODEL`        | 空                    | 安全判定使用的上游模型；留空表示沿用当前请求映射后的模型                  |
| `WORKBUDDY_SAFEGUARDS_TIMEOUT_MS`   | `60000`               | 单次安全判定的超时；超时按 `unavailable` 处理（fail-closed）              |
| `WORKBUDDY_DEBUG`                   | `0`                   | 设为 `1` 输出调试日志                                                     |
| `WORKBUDDY_DUMP_REQUEST`            | 空                    | 设为文件路径时，把最终发往上游的请求体写入该文件（含用户内容，仅调试用）  |
| `WORKBUDDY_REQUEST_TIMEOUT_MS`      | `600000`              | 单次聊天请求超时，单位毫秒                                                |

macOS / Linux 更换端口示例：

```sh
WORKBUDDY_PROXY_PORT=3457 wcc
# 停止同一个端口：
WORKBUDDY_PROXY_PORT=3457 wcc stop
```

Windows PowerShell：

```powershell
$env:WORKBUDDY_PROXY_PORT = '3457'
wcc
# 同一终端可直接停止；另开终端则需要重新设置相同端口：
wcc stop
```

更换端口后，Claude CLI 的 `ANTHROPIC_BASE_URL` 也需要改为对应地址。

## 验证服务

```sh
curl http://127.0.0.1:3456/health
curl http://127.0.0.1:3456/v1/models
```

健康接口返回 `ok`、`signedIn` 和模型数量；模型目录以当前 WorkBuddy 账号的响应为准。
`/v1/messages` 支持流式和非流式响应；`/v1/messages/count_tokens` 返回的是本地估算值。
`/v1/chat/completions` 接受 OpenAI 请求：`stream: true` 返回 SSE，省略或设为 `false`
返回完整 JSON。`stream_options.include_usage: true` 时流中带用量；`max_completion_tokens`
会转换成上游的 `max_tokens`，并按模型输出上限裁剪。仅支持 `n=1`。
共享的 `/v1/models` 同时保留 Anthropic 字段并提供 OpenAI 的 `object`、`created`、`owned_by`。

```sh
curl http://127.0.0.1:3456/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer workbuddy-local' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

## 兼容性说明

- **渠道校验**：WorkBuddy 国内网关会拦截 Claude Code 注入的
  `x-anthropic-billing-header:` 行、`To give feedback ... github.com/anthropics/...`
  这类反馈行，以及部分客户端身份句（HTTP 400 / code 11128）。代理默认会在发给
  WorkBuddy 的 `system` / `assistant` 文本里移除这些标记，用户消息和工具结果
  保持原样。可用 `WORKBUDDY_REWRITE_CLIENT_IDENTITY=0` 关闭。
- **加密凭据**：目前只支持明文凭据文件（WorkBuddy 5.5.x）。5.6+ 的加密格式会
  明确报错，需要先打开 WorkBuddy App 重新登录或等后续适配。
- **模型别名**：Claude Code 若发送 `claude-*`、`sonnet`、`opus`、`haiku` 等
  非 WorkBuddy id，会映射到 `WORKBUDDY_DEFAULT_MODEL`。Claude Code 会打印
  `[claude-code:unrecognized_model]` 警告，这是客户端的提示，不影响请求。
- **工具调用**：已支持 Claude Code 的 `Read` 等工具；模型本身必须支持函数调用
  （`deepseek-v4.1-flash`、`glm-5.3` 等已验证）。
- **auto 权限模式**：Claude Code 2.1.278 起，auto 模式会在请求里带 `safeguards`，
  并要求响应返回 `safeguard_results`。代理默认开启服务端判定：对模型返回的每个
  工具调用再请求一次上游模型做危险动作分类，流式结果放在最后一个 `message_delta`，
  非流式放在响应顶层。判定失败或超时会返回 `status.type: "unavailable"`，Claude Code
  会拦下该调用（fail-closed），不会伪造放行。可用 `WORKBUDDY_SAFEGUARDS=0` 关闭；
  关闭后 auto 模式在代理下不可用。
  判定依赖上游模型严格输出判定 JSON，非 Anthropic 模型偶尔会夹带说明文字、大小写
  不统一或漏掉某个工具调用；代理会逐个花括号配平取判定对象、忽略大小写，只有确实
  缺失判定时才按 `unavailable` 处理。另外分类请求会照抄原请求的 `safeguards`
  声明，但不跟随原请求的中止信号（Claude Code 可能在判定期间先断开原连接）。
  请求声明了 `safeguards`、但这一轮回复里没有工具调用时，返回 `available` 且
  `tool_uses` 为空的裁决；不能返回空数组 —— Claude Code 会把 `safeguard_results: []`
  读成「服务端没有裁决」，整个会话随即回退到它自带的分类请求（并弹出分类计费提示）。
  被拦下时会往日志写一行
  `安全判定失败（按 unavailable 拦截）:` 及原因，按日志里的原因排查即可。

  遇到 `claude-sonnet-5 is temporarily unavailable, so auto mode cannot determine the safety of Bash`
  时，表示 auto 分类未完成，不能仅凭模型显示名判断真实上游模型下线，也不表示 Bash 语法错误。
  优先查看代理日志：`TimeoutError` 表示分类超时；`没有返回 JSON 判定` 或 `缺少工具调用`
  表示模型输出格式不符合要求。默认分类超时已由 20 秒延长到 60 秒；上游较慢时可在启动代理前
  设置 `WORKBUDDY_SAFEGUARDS_TIMEOUT_MS=120000`，修改后重启代理才会生效。

  更稳定的人工审批方式是 `claude --permission-mode default`，或 `acceptEdits`。
  持久设置应写成 `"permissions": { "defaultMode": "acceptEdits" }`，而不是顶层 `defaultMode`。
  这些模式仍保留 Claude Code 的审批机制，不依赖 auto 分类模型。
  具体行为见[官方权限模式文档](https://code.claude.com/docs/en/permission-modes)。

- **旧版客户端**：Claude Code 2.1.277 及更早版本由客户端自己做安全判定，判定请求
  同样走当前模型；非 Anthropic 模型不一定能稳定输出判定格式，auto 模式下 Bash
  可能被间歇性拦下。建议改用 `claude --permission-mode default` 或 `acceptEdits`。
- **图片**：模型目录声明支持图片时，代理会把 Anthropic 图片块转成 `image_url`；
  纯文本模型会由上游拒绝。
- **计费**：请求走你自己的 WorkBuddy 账号，消耗其积分；代理只读取状态，不绕过计费。
  auto 模式开启服务端判定后，每个带工具调用的回合会额外消耗一次上游请求。

## 安全与使用范围

- 只监听本机回环地址，并校验 `Host`/`Origin`，降低 DNS rebinding 风险。
- 不记录 access token / refresh token；刷新副本写在 `~/.workbuddy-claude/`，权限 0600。
- 运行控制文件同样限制为本机用户读写，按端口记录随机停止令牌；`stop` 通过本机接口关闭代理。
- 这是第三方兼容层，与腾讯/WorkBuddy/Anthropic 均无关联。请遵守 WorkBuddy 的服务
  条款，仅供个人学习与研究使用，后果自负。

## 开发与发布

```sh
npm install
npm run verify
npm pack --dry-run
npm publish
```

发布包仅包含入口、运行模块、README 和许可证文件；不包含测试、开发工具、登录凭据或本机配置。
CI 在 macOS、Windows、Linux 上运行检查；本机真实 WorkBuddy 账号调用需要另外验证。

## 文件导航

- [server.mjs](server.mjs)：CLI 命令、HTTP 路由和服务生命周期
- [lib/anthropic.mjs](lib/anthropic.mjs)：Anthropic / OpenAI 协议转换
- [lib/chat-route.mjs](lib/chat-route.mjs)：OpenAI 聊天 HTTP 入口与取消、超时处理
- [lib/openai.mjs](lib/openai.mjs)：OpenAI 请求校验、非流式聚合与流式输出
- [lib/sse.mjs](lib/sse.mjs)、[lib/http.mjs](lib/http.mjs)：共用 SSE 读取与 HTTP 错误映射
- [lib/safeguard.mjs](lib/safeguard.mjs)：auto 模式的服务端安全判定
- [lib/upstream.mjs](lib/upstream.mjs)：WorkBuddy 请求、目录和错误处理
- [lib/credential.mjs](lib/credential.mjs)：桌面登录态与刷新副本
- [lib/service.mjs](lib/service.mjs)：运行状态与停止控制
- [lib/daemon.mjs](lib/daemon.mjs)：后台进程、启动确认和日志输出
- [lib/config.mjs](lib/config.mjs)、[lib/identity.mjs](lib/identity.mjs)：配置与客户端版本
- [test/](test/)：协议与 CLI 回归测试
- [tests/openai.test.mjs](tests/openai.test.mjs)：OpenAI 协议、SSE 分片与 HTTP 路由回归
- [package.json](package.json)：npm 元数据、发布文件清单和开发命令
- [.github/workflows/ci.yml](.github/workflows/ci.yml)：三平台检查；[.gitattributes](.gitattributes) 统一源码换行

## 来源与许可

本项目从 [dsh-workbuddy-bridge](https://github.com/dsh-plugin-lab/dsh-workbuddy-bridge) 的
Claude CLI 兼容代理独立整理，保留上游版权声明。详见 [NOTICE](NOTICE) 和 [MIT 许可证](LICENSE)。

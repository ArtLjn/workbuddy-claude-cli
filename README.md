# workbuddy-claude-cli

**支持 Claude CLI（Claude Code）接入 WorkBuddy 模型。** 一条命令安装，使用
`wcc` 启动本地 Anthropic Messages API 兼容代理，复用 WorkBuddy 桌面 App 登录态。

原理：Claude Code 说 Anthropic Messages API，WorkBuddy 上游说 OpenAI Chat Completions。
本代理在 `127.0.0.1` 上把两边互相翻译，复用 WorkBuddy 桌面 App 的登录态，
不改 Claude Code 本体，也不依赖 DSH。

## 前置

- Node.js ≥ 22（`node -v`）
- 已安装并登录 WorkBuddy 桌面 App（国内版默认；国际版见 `WORKBUDDY_REGION`）
- 已安装 Claude CLI（Claude Code）；本包提供兼容代理，不包含 Claude Code 本体
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

## 代理环境变量

| 变量                                | 默认值                | 说明                                                                      |
| ----------------------------------- | --------------------- | ------------------------------------------------------------------------- |
| `WORKBUDDY_REGION`                  | `cn`                  | `cn` = WorkBuddy 国内版；`global` = WorkBuddy AI 国际版                   |
| `WORKBUDDY_AUTH_FILE`               | 平台默认              | 桌面 App 凭据文件路径；留空自动探测                                       |
| `WORKBUDDY_PROXY_HOST`              | `127.0.0.1`           | 监听地址；不建议改成 0.0.0.0                                              |
| `WORKBUDDY_PROXY_PORT`              | `3456`                | 监听端口                                                                  |
| `WORKBUDDY_DEFAULT_MODEL`           | `deepseek-v4.1-flash` | 请求模型不是 WorkBuddy id（如 `claude-*`）时使用的兜底模型                |
| `WORKBUDDY_REASONING_EFFORT`        | 空                    | 固定发送 `low`/`medium`/`high`/`xhigh`/`max`；空表示不干预                |
| `WORKBUDDY_PROXY_TOKEN`             | 空                    | 设置后 Claude Code 必须带相同的 Bearer/`x-api-key`                        |
| `WORKBUDDY_CLAUDE_HOME`             | `~/.workbuddy-claude` | 刷新后凭据副本目录（权限 0600）                                           |
| `WORKBUDDY_REWRITE_CLIENT_IDENTITY` | `1`                   | 设为 `0` 关闭客户端身份清洗（关闭后 Claude Code 会被 WorkBuddy 网关拦截） |
| `WORKBUDDY_SHOW_REASONING`          | `0`                   | 设为 `1` 把上游 `reasoning_content` 作为 thinking 块返回                  |
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
- **图片**：模型目录声明支持图片时，代理会把 Anthropic 图片块转成 `image_url`；
  纯文本模型会由上游拒绝。
- **计费**：请求走你自己的 WorkBuddy 账号，消耗其积分；代理只读取状态，不绕过计费。

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
- [lib/upstream.mjs](lib/upstream.mjs)：WorkBuddy 请求、目录和错误处理
- [lib/credential.mjs](lib/credential.mjs)：桌面登录态与刷新副本
- [lib/service.mjs](lib/service.mjs)：运行状态与停止控制
- [lib/daemon.mjs](lib/daemon.mjs)：后台进程、启动确认和日志输出
- [lib/config.mjs](lib/config.mjs)、[lib/identity.mjs](lib/identity.mjs)：配置与客户端版本
- [test/](test/)：协议与 CLI 回归测试
- [package.json](package.json)：npm 元数据、发布文件清单和开发命令
- [.github/workflows/ci.yml](.github/workflows/ci.yml)：三平台检查；[.gitattributes](.gitattributes) 统一源码换行

## 来源与许可

本项目从 [dsh-workbuddy-bridge](https://github.com/dsh-plugin-lab/dsh-workbuddy-bridge) 的
Claude CLI 兼容代理独立整理，保留上游版权声明。详见 [NOTICE](NOTICE) 和 [MIT 许可证](LICENSE)。

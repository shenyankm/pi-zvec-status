# pi-zvec-status

**在 Pi 中查看和管理当前项目的 zvec-grep 索引，无需离开会话切换到终端查询。**

`pi-zvec-status` 是一个 Pi 扩展：在底部状态栏持续显示索引是否就绪，并通过 `/zvec` 提供索引状态和管理菜单。

这是独立的第三方扩展，不是 zvec-grep 官方组件。使用已有 MCP 接口，不解析 CLI 展示文本，也不向模型注册额外工具。后台只查询状态，索引管理操作仅在用户通过 `/zvec` 明确确认后执行。

## 插件有什么用？

使用 zvec-grep 为项目建立语义搜索索引时，你可能需要确认：项目是否已有索引、索引是否需要更新、后台任务是否正在运行，以及当前使用哪个 embedding 模型。本插件把这些信息放到 Pi 界面中，并提供常用管理操作。

| 功能 | 说明 |
| --- | --- |
| 状态栏提示 | 显示 `ready`、`indexing`、`no index`、`stale`、`failed` 等英文状态；服务端提供整体进度时显示完成数。 |
| 项目状态面板 | 查看当前目录、embedding 模型、索引路径，以及已存储、待更新和失败文件数。 |
| 索引管理 | 在菜单中创建索引、增量更新、重建，或切换本地 embedding 模型并重建。 |
| 模型缓存识别 | 区分 `Downloaded`、`Not downloaded` 和 `Cache unknown`，已下载的模型优先显示。 |
| 操作确认 | 索引写操作需要确认；未下载或缓存未知的本地模型还需要单独确认下载。 |

**它不是搜索引擎本身。** 项目扫描、模型下载、向量计算和索引任务由 zvec-grep daemon 执行；搜索仍通过 zvec-grep 提供的工具或 CLI 完成。插件不会自动启动服务、自动建立索引或修改全局默认模型，也不提供删除索引的操作。

## 日常使用

安装并连接 zvec-grep 服务后：

1. 从需要管理索引的项目目录启动 Pi。
2. 查看底部状态栏，例如 `● zvec · ready` 或 `○ zvec · no index`。
3. 输入 `/zvec`，打开 **Overview / Workspace / Actions** 面板。
4. 选择刷新、创建、更新或重建；需要切换模型时选择 **Switch model and rebuild**。
5. 核对确认提示后再提交操作。任务在后台运行，状态栏会定期刷新；也可以在面板中选择 **Refresh status**。

界面使用英文，本文档使用中文。查询对象是 Pi 的当前工作目录，不会自动向上寻找项目根目录；具体安装、连接方式和操作限制见下文。

## 安装

要求 Node.js 22.19+、Pi 1.4.x 或同一 1.x 系列的后续兼容版本（使用 `@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-tui`），以及支持 `zvec_grep_index_status` 的 zvec-grep 本地 HTTP MCP 服务。

本地开发安装：

```bash
cd /Users/sheny/Developer/code/pi-zvec-status
npm ci --omit=peer
pi install /Users/sheny/Developer/code/pi-zvec-status
```

在已打开的 Pi 会话中执行 `/reload`，或启动新会话。也可以不安装，仅试用一次：

```bash
pi -e /Users/sheny/Developer/code/pi-zvec-status/index.ts
```

上面的绝对路径是本机示例，其他机器请替换为实际目录。

### zvec-grep 服务

插件**不会启动、停止或重新配置服务**。状态工具属于 `full` 工具集；如尚未启动服务，请自行执行：

```bash
zg --server on --mcp-toolset full
```

如果已有服务仅开放 `agent` 工具集，需在合适的时候手动停止并以 `full` 重启。重启会影响使用同一个 daemon 的其他客户端；扩展不会代为操作。

注意：`full` 也会在该服务上开放索引管理工具，不只是状态查询。插件后台只调用状态工具；用户确认索引操作后才调用索引管理工具，其他已连接客户端也可能访问这些工具。插件不依赖 Pi 自身的 MCP 配置，也不会修改它。

## 使用

状态示例：

```text
● zvec · ready
◌ zvec · indexing 40/128
! zvec · stale
○ zvec · no index
! zvec · unavailable
```

图标与状态使用 Pi 当前主题的语义色：就绪为绿色、查询和索引中为强调色、警告为警告色、失败为错误色；名称使用柔和颜色，所有状态均在名称后显示英文说明；就绪时显示 `ready`，不显示文件数。弹窗中仍保留完整状态文字。运行中的创建、更新和重建任务按服务端状态统一显示 `indexing`，有整体进度时附带完成数。

还支持 queued、failed、cancelled、disabled、rebuild required 和 unknown。

- 交互式会话启动时查询一次，之后每次查询完成 **30 秒**后再次查询。
- `/zvec`：打开当前项目索引状态和操作菜单；原 `/zvec-status` 已合并移除。
- 弹窗按 Overview、Workspace、Actions 分区；状态使用语义色，路径等次要信息弱化，字段标签对齐，窄终端中自动换行。显示项目目录、索引状态、embedding 模型、已存储/待更新/失败文件数和索引路径。
- 支持刷新状态、创建索引、增量更新、重建，以及切换本地 embedding 模型并重建。
- 每项写操作都需要确认；有排队或运行中的任务，或状态格式无法识别时，仅提供刷新和关闭。提交前再次检查状态，避免使用过期的确认。无法确定当前模型时不会提交任务。
- 索引操作在 daemon 后台运行；退出菜单或 Pi 不会撤销已提交的任务。
- 仅当最终显示内容变化时更新 footer，避免重复刷新。
- 请求总期限为 **10 秒**；同时发生的刷新合并为同一个请求。
- 退出、切换会话或 `/reload` 时停止定时器并取消请求。
- print、JSON、RPC 等非 TUI 模式不启动后台查询。
- 使用 `ctx.ui.setStatus()`，不替换 Pi 默认 footer。第三方自定义 footer 需要自行显示扩展状态。

查询根目录为 Pi 提供的 `ctx.cwd`，不会自行向上查找 Git 仓库或索引目录。从子目录启动 Pi 时，显示的是该目录对应的状态。

### 连接与认证

复用 zvec-grep 已有环境变量，无需配置文件：

| 环境变量 | 默认值 / 含义 |
| --- | --- |
| `ZVEC_GREP_SERVER_URL` | `http://127.0.0.1:7999/mcp` |
| `ZVEC_GREP_SERVER_TOKEN` | 可选 Bearer token，优先于 token 文件 |
| `ZVEC_GREP_SERVER_TOKEN_FILE` | 可选 token 文件路径，读取后去除首尾空白 |

这些变量必须由 **Pi 进程**继承；仅在 Pi 的 MCP 配置中设置环境变量不会传给此扩展。

仅接受 HTTP(S) loopback 地址：`127.0.0.1`、`localhost`、`[::1]`。不接受 URL 用户名、密码、query 或 fragment，避免向远端发送工作目录或在 URL 中泄露认证信息。

每次轮询建立一个短期 MCP 会话，完成后终止并关闭连接。断连、认证失败或接口不兼容时显示 unavailable，下次轮询重试，不反复弹窗，不展示服务端原始错误或凭据。

## 操作边界与限制

后台轮询仅调用 `zvec_grep_index_status({ root })`。用户确认后，菜单通过 `zvec_grep_index({ root, wait: false, ... })` 提交创建、增量更新或重建任务。不提供删除索引、切换其他项目、修改全局模型配置或授予远程 embedding 权限的操作。

“切换索引”在此指切换当前项目的 embedding 模型并重建，而不是更改 Pi 工作目录。模型选择仅列出 zvec-grep 0.2.2 支持的本地模型。列表标记 `Downloaded` / `Not downloaded`，已下载项优先显示；配置或缓存无法读取时标记 `Cache unknown`，不误判为未下载。所有可能使用本地模型的写操作（创建、切换、沿用模型更新和重建）都统一检查下载授权。模型为 `Not downloaded` 或 `Cache unknown` 时，必须先通过独立的 `Download model?` 下载授权确认，再确认索引操作；取消任一步均不会提交任务。已下载的模型跳过下载授权，但仍需确认索引操作；若确认期间缓存被清理，提交前检查会阻止本次操作，重新选择操作后再确认下载。每次打开列表仅检查本地完成标记和预期文件大小，不加载模型、不联网、不下载，也不对大型权重重新计算哈希。支持 Hugging Face 和 ModelScope 缓存。

缓存目录按 zvec-grep 的顺序解析：`~/.zvec-grep/config.json` 中的 `defaults.modelCacheDir`、`ZVEC_GREP_MODEL_CACHE`、`$ZVEC_GREP_HOME/models` 或默认 `~/.zvec-grep/models`。Pi 与 daemon 必须使用相同缓存设置；daemon 独立的 `--model-cache` 参数无法通过现有状态接口获知。缓存检测适配 0.2.2 的模型目录与快照，后续版本更换目录或模型版本时需要同步更新。未缓存的模型首次使用可能下载。已有远程模型可以沿用更新或重建，但必须已有用户授权，插件不会代为授权。切换模型和重建期间，搜索可能暂不可用。

提交超时不代表任务未被接受，请先刷新状态再重试。多个客户端间的提交竞争最终由 daemon 处理。

后台状态查询也不代表服务端完全无副作用：状态接口可能扫描本地文件、激活工作区运行时或 watcher。大工作区、多 Pi 会话的轮询开销取决于 zvec-grep 实现。

状态来自服务端已有快照，不额外扫描或校验文件。进度仅在服务端提供 completion 时展示；不会把单阶段计数冒充整体百分比。未知或不兼容响应不会显示为 ready。

## 开发与验证

```bash
npm ci --omit=peer
npm run check
npm run coverage
npm pack --dry-run
```

源码和测试均使用 TypeScript，开启 strict 类型检查。Pi 直接加载 `index.ts`，无需构建；测试使用 Node 内置 TypeScript 类型擦除和 test runner。`npm run check` 先检查类型再运行测试。

运行时使用 MCP 官方 SDK，并在首次查询时才加载，非 TUI 模式不加载 SDK。自定义菜单仅在打开时加载，并使用 Pi 宿主提供的 pi-tui 原生组件，不引入额外 UI 框架。TypeScript、Node 类型和用于开发类型检查的 Pi、pi-tui 均为 devDependencies；Pi 和 pi-tui 同时声明为宿主 peer，不随插件打包。测试覆盖状态映射、真实 HTTP MCP 协议交互、认证、只读调用、连接清理、刷新合并、footer 去重与主题切换、命令菜单、确认和取消、索引提交参数、错误恢复及非交互模式。

测试使用临时缓存和本地模拟 MCP 服务，不依赖用户已下载的模型。覆盖下载拒绝/取消、缓存变化、异常状态不误报 ready、会话切换与重载、并发菜单、401/403、重定向拒绝、token 文件失败、提交结果校验及服务端接受后响应超时且不自动重试。

`npm run check` 包含真实 Pi 加载器的包发现/TypeScript 加载冒烟测试。`npm run coverage` 仅统计插件源码，并通过测试名过滤暂不执行加载器冒烟用例，避免 jiti 转译副本干扰原始源码行号；完整冒烟测试仍由 `check` 运行。

GitHub Actions 配置覆盖 Linux/macOS/Windows、Node 22.19 与 24，以及锁定的 Pi 1.4.0 和最新兼容 1.x 宿主。工作流需要推送到 GitHub 后才能执行；CI 不下载模型，也不操作真实索引。真实 daemon 和 TUI 的隔离验收步骤见 [手工验收清单](docs/verification.md)。发布前仍需项目所有者确定许可证。

卸载：

```bash
pi remove /Users/sheny/Developer/code/pi-zvec-status
```

之后执行 `/reload`。卸载不会停止共享 zvec-grep daemon，也不会删除索引。

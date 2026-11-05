# QQ Harness Bot

个人 QQ 聊天机器人：腾讯官方 Node SDK、LangChain.js、LangGraph.js、Deep Agents.js 和 SQLite。QQ群消息先保存原文，默认只有 @机器人时才调用模型，也可自行配置触发关键词；耗时工作交给后台子 Agent，支持回调和分段交付。

## 一键启动

启动 Docker Desktop，在项目目录执行：

```powershell
.\start.ps1
```

脚本会创建 `.env`，构建并启动机器人、搜索和 Python 沙箱。首次运行后在 `.env` 中填写 `MODEL_API_KEY`；模型配置按新回合读取，启动自检失败后会自动重试。请勿把密钥发到群里或提交到 Git。旧版本若使用 Docker 数据卷，启动脚本会先停止旧机器人、复制并检查数据库，成功后保留旧卷作为回退；目标数据目录非空时不会覆盖。

若 PowerShell 禁止执行脚本，运行 `powershell -ExecutionPolicy Bypass -File .\start.ps1`。也可从 `.env.example` 手动创建 `.env`，然后执行 `docker compose up -d --build`。

打开 <http://127.0.0.1:8765> 查看检查结果和绑定状态，使用手机 QQ 扫码绑定。凭据存入 SQLite；正常断线自动重连，程序重启会读取数据库，无需再次扫码。QQ 接入与模型自检独立；模型暂不可用时 QQ 仍尝试连接并保存收到的消息。只有模型、搜索等已启用依赖自检通过且 QQ 已连接，状态才会变为 `ready`。

```powershell
docker compose ps
docker compose logs -f bot
docker compose stop
```

## 模型配置

`.env` 中的 `MODEL_PROVIDER` 支持 `openai` 或 `anthropic`，并通过 `MODEL_BASE_URL`、`MODEL_NAME`、`MODEL_API_KEY` 配置标准兼容接口。DeepSeek Anthropic 格式的地址示例：`https://api.deepseek.com/anthropic`。更换模型后应检查 `config/config.yaml` 的 `model.vision` 和 `model.contextTokens` 是否符合该模型。

管理页“运行配置”也可设置模型、记忆和任务参数；设置保存在 SQLite 并优先于 `.env`，新回合生效。页面不会回显 API 密钥，留空表示保留现有值。

模型配置文件在容器中只读挂载，每次新回合会重新读取；如果编辑器通过替换文件而不是原位保存导致 Docker 仍看到旧文件，运行 `docker compose up -d --force-recreate bot` 重新挂载。修改挂载目录本身也需要重新创建容器，不需要重新构建镜像。

## 工作区与沙箱

`.env` 的 `BOT_WORKSPACE_HOST` 指定工作区宿主机目录，默认项目下的 `workspace/`，挂载到 `/workspace`。每个会话使用稳定的哈希子目录；脚本、下载和交付文件在对应目录中。`BOT_DATA_HOST` 指定数据库宿主机目录，默认项目下的 `data/`，挂载到 `/data`；`BOT_SQLITE_PATH` 和 `BOT_CHECKPOINT_PATH` 是该容器内目录下的数据库文件路径。原始消息、QQ 凭据、记忆和任务都存 SQLite 表，thread checkpoint 单独保存。变更挂载位置需要迁移现有文件，然后重新创建容器，不能直接指向空目录。

SQLite 使用 WAL，备份时应先停止机器人，完整备份整个数据目录；不要在程序写入时只复制一个 `.sqlite` 文件。`migrate-data.ps1` 面向旧版默认文件名，比较迁移前后数据库文件哈希、完整性和各表记录数量，保留原 Docker 卷。已有数据目录非空时，它会停止并要求人工检查，不会覆盖。数据库和备份包含 QQ 凭据、聊天记录，注意宿主机访问权限。

`.env` 还提供 `BOT_CONFIG_HOST`、`BOT_PLUGINS_HOST`、`BOT_MODEL_ENV_HOST`、`SEARXNG_CONFIG_HOST`、`BOT_WEB_BIND` 和 `BOT_WEB_PORT`。目录映射由 Docker Compose 在容器创建时应用；修改后重新运行 `start.ps1`。管理接口默认仅接受本机访问，勿把管理端口暴露到公网。

默认 `workspace/` 已被 Git 忽略。若将工作区改到项目内其他目录，提交前应将该目录也加入 `.gitignore`；容器构建上下文使用白名单，不包含工作区、密钥和聊天数据。

机器人使用非 root 用户、只读容器根文件系统、临时目录、移除 Linux capabilities 和 `no-new-privileges`，不挂载 Docker socket。`config/`、`.env` 和 `plugins/` 只读；工作区和数据库目录可写。QQ、模型、搜索和媒体工具需要网络；映射工作区本身对容器可写，不应映射包含私人文件的目录。

Python 在独立容器执行。工具只复制当前会话显式指定的脚本和输入文件，执行后将生成或修改的文件写回该会话工作区；可使用标准库、Pillow 和预装的 Noto 中文字体。根据 `sandbox.permissions` 配置，Python 或 shell 可以联网、执行子进程和自由制作图片；任务运行于独立容器，不挂载机器人凭据或数据库。执行容器与机器人交换的是本次任务显式选择的输入和输出文件，并通过同一会话工作区供发送工具使用。执行环境启动时限制对宿主机管理端口的访问，并降为非 root 用户；请不要把含私密资料的主机目录映射为工作区。文件输入和输出各有大小、数量限制，长任务交给后台子 Agent。脚本结果包含退出码和日志，失败不会导入产物。文件工具、Python 和发送工具使用一致的会话路径；发送 SVG 图片时会在隔离容器转换为 PNG。QQ 原生卡片为默认卡片；仅明确要求图片时使用图片渲染工具，实际卡片能力受 QQ 权限限制。

`config/config.yaml` 的 `sandbox.permissions` 可控制工具的外部网络、子进程、工作区读和写；工具按声明过滤，Deep Agents 文件工具也应用读写规则。此配置约束项目提供的工具，并非针对任意插件的网络防火墙；插件与主程序同进程运行，只安装可信插件。新增工具插件的声明方式见 `plugins/README.md`。

## 聊天记录与配置

原始记录与 thread 上下文、摘要和长期记忆分别保存。运行 `docker compose exec -T bot node dist/cli/history.js list` 列出会话，再运行 `docker compose exec -T bot node dist/cli/history.js export 会话ID > history.jsonl` 导出该会话的原文和平台事件。

- `config/config.yaml`：触发关键词、模型能力、记忆、工具、权限和任务配置，新回合读取。
- SQLite：主人格首次从 `config/persona.md` 导入，可在本机管理页面修改，下一回合生效。
- `plugins/`：可信工具插件；启动时加载，也可在运行配置页自检后热重载，新回合生效。
- `.env`：模型接口密钥、数据库和工作区映射；已被 Git 忽略。

管理页面提供群聊配置、近期原始消息、后台任务、记忆、身份与权限、主人格和交付记录。用户记忆与群记忆分别存储；群聊与私聊 OpenID 不一定相同，可在身份页面手工关联。初次扫码返回的私聊身份用于初始化创建者，群身份需要确认后关联才能获得创建者权限；不要仅凭昵称关联。旧版无法识别主体的记忆保留在旧表，不会猜测为群记忆。

“聊天记录”可按会话、内容和发言人分页检索 SQLite 原文；“待处理记忆”可为旧记忆确认归属，原记录仍保留。用户明确要求记住自己的事实时可立即保存，无需等待摘要阈值。创建者明确要求时可以调用官方 QQ 开放平台接口；后台任务会重新核对创建者当前身份。

触发只控制是否启动模型；启动后会结合近期群聊、说话人和时间理解相关插话。长任务执行期间的补充与纠正也会传给执行过程和完成回调。其他消息单独到来时仍只记录，不会唤醒模型。主聊天回复和子任务均有工具调用预算，防止反复调用。

`.env` 中的 `SEARCH_PROVIDER=auto` 会在使用 DeepSeek 官方模型地址时优先使用其结构化联网搜索，其余情况使用 SearXNG；也可指定 `deepseek` 或 `searxng`。DeepSeek 搜索由 `DEEPSEEK_SEARCH_BASE_URL` 和 `DEEPSEEK_SEARCH_MODEL` 配置。搜索结果需要读取原文和核对时间；DeepSeek 搜索本身不保证强制时间范围过滤。图片搜索优先尝试 SearXNG，无法获得图片时会搜索来源网页并提取图片链接，仍需要核对素材是否符合要求。联网搜索实现参考 [DeepSeek Harness 的搜索插件](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/web/web-search-deepseek)。

明确要求最新、热门、实时或排行时，Harness 要求读取至少一个来源原文，否则不直接输出未经核实的结论。模型仍需判断来源的相关性和时效，系统不能保证识别每个隐含的时效问题或保证来源本身正确。

回复使用 QQ SDK 的原生 `sendMarkdown`（参考 [DSH QQ 出站实现](https://github.com/tencent-connect/dsh-qqbot/blob/main/src/transport/outbound.ts)），代码块跨长消息分段时重新闭合。QQ 账号是否具备 Markdown 渲染能力以及不同客户端的呈现应以实际平台返回和客户端为准；发送失败会记录，不能当作已成功渲染。默认启用搜索和媒体下载。语音方案待定，当前默认关闭，不安装或启用语音合成服务。

## 开发与检查

`src/` 按 `platform/qq`、`agent`、`models`、`storage`、`tools`、`delivery`、`startup`、`config`、`domain` 和 `cli` 分层。主入口是 `src/index.ts`。

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run doctor
```

启动时也会运行自检。`npm run doctor:dev -- --offline` 仅检查本地组件，不验证在线模型和搜索；`/healthz` 表示进程存活，`/readyz` 表示启动检查和 QQ 连接均通过。

QQ 是否推送全部群消息、允许主动消息或文件发送，取决于实际账号和群权限。群聊、单聊、频道、频道私信和按钮事件使用官方底层网关；频道可发送 Markdown、ARK、Embed 和图片，频道本地文件及视频受官方接口限制。`QQ_INTENTS` 可选配置订阅位掩码，留空使用 SDK 默认订阅；普通频道消息需要相应平台权限和订阅。其余订阅事件记录在 SQLite，可在管理页查看。

异步任务由本项目运行时实现，重启时尝试从独立检查点恢复；未完成的外部工具步骤可能重新执行，发送结果未知时不会自动重发。分段交付通过发送工具完成，不保证 QQ 原生逐 token 更新。

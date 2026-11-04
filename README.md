# QQ Harness Bot

个人 QQ 聊天机器人：腾讯官方 Node SDK、LangChain.js、LangGraph.js、Deep Agents.js 和 SQLite。QQ群消息先保存原文，只有 @机器人或命中关键词才调用模型；耗时工作交给后台子 Agent，支持回调和分段交付。

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

模型配置文件在容器中只读挂载，每次新回合会重新读取；如果编辑器通过替换文件而不是原位保存导致 Docker 仍看到旧文件，运行 `docker compose up -d --force-recreate bot` 重新挂载。修改挂载目录本身也需要重新创建容器，不需要重新构建镜像。

## 工作区与沙箱

`.env` 的 `BOT_WORKSPACE_HOST` 指定工作区宿主机目录，默认项目下的 `workspace/`，挂载到 `/workspace`。每个会话使用稳定的哈希子目录；脚本、下载和交付文件在对应目录中。`BOT_DATA_HOST` 指定数据库宿主机目录，默认项目下的 `data/`，挂载到 `/data`；`BOT_SQLITE_PATH` 和 `BOT_CHECKPOINT_PATH` 是该容器内目录下的数据库文件路径。原始消息、QQ 凭据、记忆和任务都存 SQLite 表，thread checkpoint 单独保存。变更挂载位置需要迁移现有文件，然后重新创建容器，不能直接指向空目录。

SQLite 使用 WAL，备份时应先停止机器人，完整备份整个数据目录；不要在程序写入时只复制一个 `.sqlite` 文件。`migrate-data.ps1` 面向旧版默认文件名，比较迁移前后数据库文件哈希、完整性和各表记录数量，保留原 Docker 卷。已有数据目录非空时，它会停止并要求人工检查，不会覆盖。数据库和备份包含 QQ 凭据、聊天记录，注意宿主机访问权限。

`.env` 还提供 `BOT_CONFIG_HOST`、`BOT_PLUGINS_HOST`、`BOT_MODEL_ENV_HOST`、`SEARXNG_CONFIG_HOST`、`BOT_WEB_BIND` 和 `BOT_WEB_PORT`。目录映射由 Docker Compose 在容器创建时应用；修改后重新运行 `start.ps1`。管理接口默认仅接受本机访问，勿把管理端口暴露到公网。

默认 `workspace/` 已被 Git 忽略。若将工作区改到项目内其他目录，提交前应将该目录也加入 `.gitignore`；容器构建上下文使用白名单，不包含工作区、密钥和聊天数据。

机器人使用非 root 用户、只读容器根文件系统、临时目录、移除 Linux capabilities 和 `no-new-privileges`，不挂载 Docker socket。`config/`、`.env` 和 `plugins/` 只读；工作区和数据库目录可写。QQ、模型、搜索和媒体工具需要网络；映射工作区本身对容器可写，不应映射包含私人文件的目录。

Python 在独立容器执行。工具只复制当前会话显式指定的脚本和输入文件，执行后将生成或修改的文件写回该会话工作区；可使用标准库、Pillow 和预装的 Noto 中文字体。Python 脚本不能访问网络、启动子进程或直接读取机器人凭据和数据库；需要网络的数据通过搜索、网页或下载工具先获取。文件输入和输出各有大小、数量限制，长任务交给后台子 Agent。脚本结果包含退出码和日志，失败不会导入产物。QQ 原生卡片为默认卡片；仅明确要求图片时使用图片渲染工具，实际卡片能力受 QQ 权限限制。

`config/config.yaml` 的 `sandbox.permissions` 可控制工具的外部网络、子进程、工作区读和写；工具按声明过滤，Deep Agents 文件工具也应用读写规则。此配置约束项目提供的工具，并非针对任意插件的网络防火墙；插件与主程序同进程运行，只安装可信插件。新增工具插件的声明方式见 `plugins/README.md`。

## 聊天记录与配置

原始记录与 thread 上下文、摘要和长期记忆分别保存。运行 `docker compose exec -T bot node dist/cli/history.js list` 列出会话，再运行 `docker compose exec -T bot node dist/cli/history.js export 会话ID > history.jsonl` 导出该会话的原文和平台事件。

- `config/config.yaml`：触发关键词、模型能力、记忆、工具、权限和任务配置，新回合读取。
- SQLite：主人格首次从 `config/persona.md` 导入，可在本机管理页面修改，下一回合生效。
- `plugins/`：可信工具插件；代码在启动时加载，自检通过后注册。
- `.env`：模型接口密钥、数据库和工作区映射；已被 Git 忽略。

默认启用搜索和媒体下载。语音方案待定，当前默认关闭，不安装或启用语音合成服务。

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

QQ 是否推送全部群消息、允许主动消息或文件发送，取决于实际账号和群权限，须在真实群验证。已接入群聊及单聊的文本与媒体能力，尚未覆盖 QQ 开放平台全部频道和互动接口。异步任务由本项目运行时实现，进程重启时已中断的任务会标记中断。分段交付通过发送工具完成，不保证 QQ 原生逐 token 更新。

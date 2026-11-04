# 工具插件

启动时自动加载此目录中的 `.mjs` 文件。插件默认导出 `name`、`permissions`、`selfCheck()`、`createTools(context)`。`permissions` 声明 `network`、`process`、`workspaceRead`、`workspaceWrite` 中需要的权限；有任一项被禁用时插件工具不会注册。`selfCheck` 在依赖不可用时抛错；`createTools` 返回 LangChain 结构化工具数组。

示例（保存为独立的 `.mjs` 文件后重启容器）：

```js
import { tool } from 'langchain';
import { z } from 'zod';

export default {
  name: 'example',
  permissions: [],
  async selfCheck() {},
  createTools(context) {
    return [tool(async ({ text }) => `收到：${text}`, {
      name: 'example_echo',
      description: '回显文字。',
      schema: z.object({ text: z.string() }),
    })];
  },
};
```

`context` 包含当前会话、`background` 标记、存储、任务和回复运行时。耗时工具应仅在 `context.background === true` 时注册，以避免阻塞群聊。插件是与机器人同进程运行的可信代码，声明式权限用于注册控制，不能阻止恶意插件自行调用 Node.js API；容器仍限制其宿主机访问范围。配置变更支持热读取；新增插件代码需要重启进程。

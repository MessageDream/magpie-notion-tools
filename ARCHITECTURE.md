# 内部结构

```text
Claude Code / Codex / OpenCode
          │ Magpie 网关协议转换
          ▼
index.mjs → core.mjs → tools.mjs
                       │ 工具目录、策略、参数校验
                       ▼
                 protocol.mjs
                       │ Notion 私有网页接口
                       ▼
                 transcript.mjs
                       │ 已确认完成的回答
                       ▼
tools.mjs → 标准 tool_calls → 客户端执行 → 工具结果回传
```

`index.mjs` 只导出一个插件工厂，供 Magpie 加载。来源标识为 `notion`。

`auth-extension.mjs` 启动仅绑定 `127.0.0.1` 随机端口的短时连接页，交由系统默认浏览器打开。`extension` 中的浏览器扩展复用 Chrome 或 Edge 当前的 Notion 登录。用户点击连接后，扩展后台先校验本机连接，再通过 `chrome.cookies.get` 读取指定 Notion 域的 `token_v2`，向本机桥提交。页面与内容脚本不接触会话凭据。

本机桥验证精确的扩展 Origin、Host、一次性随机口令和请求体大小，再用 `protocol.loginInfo` 确认邮箱、用户和工作区。用户明确选择工作区并确认后，回调向 Magpie 返回 API 认证及 `email`、`spaceId`、`activeUserId` 元数据，由宿主保存。取消或超时会清理监听器和未保存会话。连接口令只放在 URL 片段中；响应不缓存，页面不运行内联脚本。`extension-config.mjs` 保存用于稳定扩展标识的公钥，不包含账号秘密。

`assets/logo.svg` 是插件的矢量图标。`package.json` 的 `magpie.icon` 内嵌同一图标，供插件列表显示；入口读取 SVG 并设置 `auth.icon`，供 Notion 来源显示。图标不依赖外部图片服务。

`core.mjs` 实现 Magpie/OpenCode provider hooks，使用宿主提供的当前账号认证，校验请求、管理取消和超时，并输出 Chat Completions JSON 或 SSE。普通未知异常只输出固定脱敏信息。

`tools.mjs` 把客户端声明的工具目录和调用策略加入提示词，将历史调用与结果按 ID 编码为数据。收到回答后校验完整 JSON、工具白名单及 JSON Schema，生成客户端调用 ID；它不读取文件、不执行命令。

`protocol.mjs` 发现工作区、读取实际模型及额度，通过 `createAgentThread`、`getThreadTranscript`、`listenToThreadTranscript` 等接口完成推理。工具模式发送完整历史并创建独立线程；普通模式使用短期内存缓存继续对话。写入推理不自动重试，避免同一任务重复提交。

额度适配分别输出标准、精选及 Notion 积分。它保留上游的分类和计量单位，不把内部计数当作请求次数。网页链路未提供可靠 token 统计，响应中的 0 仅表示缺少该统计，不能用于计算积分价格或实际 token 消耗。

`transcript.mjs` 解码 NDJSON、应用消息补丁、检查额度和完成标记。缓存模式允许上游替换临时内容，只在确认完成后交付最终文本。未完成、需要 Notion 操作或额度耗尽均返回错误。

`http-errors.mjs` 最多读取 16 KiB 的错误响应，只识别白名单中的机器错误码，输出失败接口和 HTTP 状态。原因不明的 402 标为 `payment_reason_unknown`；不把状态码或内部用量数值当作已耗尽额度的证明，也不转发上游自由文本、凭据或提示词。

依赖 `impit` 提供线程创建所需的浏览器传输，`ajv` 提供 JSON Schema 校验。浏览器连接使用 Node 内置 HTTP 服务与 Chrome 扩展接口，不启动受控浏览器。运行时认证保存在 Magpie，插件目录不保存登录或网关 Key。

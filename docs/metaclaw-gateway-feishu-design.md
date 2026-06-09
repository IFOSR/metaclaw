# MetaClaw Gateway 与飞书接入设计方案

> 状态：方案文档 / 待实现  
> 参考：Hermes Gateway 实现、`docs/hermes-gateway-feishu.md`、MetaClaw 当前 Feishu integration  
> 目标：把 MetaClaw 抽象出 Gateway 层，并优先以 WebSocket + 扫码注册 Bot 的方式快捷接入飞书客户端。

## 1. 设计目标

MetaClaw Gateway 不是一个单纯的 Feishu webhook handler，而是 MetaClaw 面向多终端的统一接入层。

Gateway 的职责：

- 接收来自飞书、终端、未来钉钉/企业微信/Slack/桌面端的用户输入。
- 把不同平台的原始事件标准化成统一 `GatewayInboundEvent`。
- 做平台访问控制、去重、群聊 @ 门控、附件缓存。
- 把事件路由到 MetaClaw session、TaskEngine、Memory、ExecutorRouter。
- 把 MetaClaw 的任务进度、最终结果、产物文件投递回原平台。
- 保证飞书展示完整最终结果，不展示 executor 原始内部上下文。

MetaClaw 与 Hermes 的差异：

- Hermes Gateway 面向 Agent 聊天会话，多平台消息是 Agent 的入口。
- MetaClaw Gateway 面向长期任务 OS，多平台消息是任务创建、恢复、调度、产物交付的入口。
- MetaClaw 的 Gateway 需要保留任务 ID、队列、长期上下文、产物、执行器路由、审计日志这些语义。

## 2. Hermes Gateway 可借鉴点

Hermes 的 Gateway 分层比较清晰：

- `gateway/platforms/base.py` 定义平台 adapter 抽象。
- `gateway/platforms/feishu.py` 实现 Feishu/Lark adapter。
- `gateway/run.py` 负责启动所有 adapter、会话缓存、进度投递、异常隔离。
- `gateway/session.py` 用 `SessionSource` 描述消息来源，并把来源注入 Agent 上下文。
- `gateway/delivery.py` 用 `DeliveryRouter` 处理 `origin`、`local`、`feishu:chat_id`、home channel 等投递目标。
- `hermes_cli/gateway.py` 负责 `hermes gateway setup/run/start/stop/status/restart`。

对 MetaClaw 最有价值的不是复制 Hermes 代码，而是复制它的边界：

```text
Platform Adapter
  ↓
Normalized Message Event
  ↓
Gateway Policy / Session Router
  ↓
Agent Runtime
  ↓
Delivery Router
  ↓
Platform Adapter Send
```

MetaClaw 应改为：

```text
Feishu / Terminal / Future Clients
  ↓
GatewayPlatformAdapter
  ↓
GatewayPolicy + GatewaySessionRouter
  ↓
MetaclawSession / TaskEngine / Memory / ExecutorRouter
  ↓
GatewayProgressPublisher + GatewayDelivery
  ↓
Platform Send / Upload / Preview
```

## 3. MetaClaw Gateway 总体抽象

### 3.1 GatewayRuntime

`GatewayRuntime` 是所有平台 adapter 的宿主。

职责：

- 读取 `~/.metaclaw/config.yaml` 和 `~/.metaclaw/.env`。
- 初始化共享 MetaClaw runtime。
- 创建并启动所有启用的平台 adapter。
- 提供 `GatewayContext` 给 adapter。
- 管理进程状态、重启、日志、健康检查。
- 关闭时 drain 正在执行的任务或标记恢复。

建议模块：

```text
src/gateway/runtime.ts
src/gateway/context.ts
src/gateway/status.ts
src/gateway/setup.ts
```

### 3.2 GatewayPlatformAdapter

平台 adapter 只关心平台协议，不关心 MetaClaw 任务逻辑。

```ts
export interface GatewayPlatformAdapter {
  readonly platform: GatewayPlatform;
  start(context: GatewayContext): Promise<void>;
  stop(): Promise<void>;
  send(target: GatewayTarget, message: GatewayOutboundMessage): Promise<GatewaySendResult>;
  uploadArtifact?(target: GatewayTarget, artifact: GatewayArtifact): Promise<GatewaySendResult>;
  addProcessingSignal?(event: GatewayInboundEvent): Promise<GatewaySignalHandle | null>;
  removeProcessingSignal?(handle: GatewaySignalHandle): Promise<void>;
}
```

### 3.3 GatewayInboundEvent

所有平台入站消息都转换成统一事件。

```ts
export interface GatewayInboundEvent {
  id: string;
  platform: 'feishu' | 'local' | 'slack' | 'dingtalk' | 'wecom';
  transport: 'websocket' | 'webhook' | 'socket' | 'http';
  messageId: string;
  chatId: string;
  threadId?: string;
  userId?: string;
  userName?: string;
  chatName?: string;
  chatType: 'dm' | 'group' | 'thread';
  text: string;
  messageType: 'text' | 'file' | 'image' | 'audio' | 'command';
  attachments: GatewayAttachment[];
  mentions?: GatewayMention[];
  raw: unknown;
  receivedAt: string;
}
```

### 3.4 GatewayPolicy

统一做入站准入判断。

策略：

- 消息去重：按 `platform + messageId` 幂等。
- DM policy：`pairing`、`allow_all`、`allowlist`。
- Group policy：`open`、`disabled`、`allowlist`、`admin_only`。
- Mention gate：群聊默认必须 @bot。
- Bot loop gate：默认拒绝 bot/app sender，避免机器人循环。
- Rate limit：按 chat/user 限速。
- Admin command gate：`/sethome`、`/gateway status` 等只允许管理员。

建议模块：

```text
src/gateway/policy.ts
src/gateway/dedup-store.ts
src/gateway/pairing-store.ts
```

### 3.5 GatewaySessionRouter

统一把入站事件交给 MetaClaw runtime。

职责：

- 判断新任务、follow-up、resume、urgent、control command。
- 管理同一 chat 的串行执行。
- 维护 `chatId -> pending resources`。
- 把附件路径追加到下一条文本指令。
- 把 `GatewayInboundEvent` 转成 `MetaclawSession.submit()` 的输入。
- 订阅 session 输出，交给进度发布器和最终结果投递器。

建议模块：

```text
src/gateway/session-router.ts
src/gateway/resource-store.ts
src/gateway/chat-queue.ts
```

### 3.6 GatewayProgressPublisher

负责用户可见的短进度。

保留：

- 任务已创建。
- 记忆召回跳过/采纳。
- 队列状态。
- 上下文构建。
- 执行器路由。
- 正在执行。
- 任务完成/失败。

过滤：

- executor 原始 stdout。
- 本地路径。
- token 统计。
- 内部 prompt。
- 蓝色内部上下文。
- session debug line。

### 3.7 GatewayDelivery

负责最终答案和 artifacts 投递。

```ts
export interface GatewayOutboundMessage {
  kind: 'progress' | 'final' | 'artifact' | 'notice' | 'error';
  markdown?: string;
  text?: string;
  artifacts?: GatewayArtifact[];
  taskId?: string;
  sourceEventId?: string;
  visibility: 'user' | 'admin' | 'debug';
  fallbackPolicy: 'split' | 'file' | 'local-only';
}
```

最终答案规则：

- 飞书最终答案只展示 CLI 绿色“任务结果”里的用户可见内容。
- 不展示蓝色内部上下文。
- Markdown 优先用飞书消息卡 `interactive + lark_md`。
- 超长内容拆成多个消息卡。
- 某个分片发送失败时，继续发送后续分片。
- 卡片失败时对该分片降级富文本。
- 卡片和富文本都失败时，上传完整 Markdown 文件作为兜底。
- 投递结果写入 audit log，记录 chunk index、发送方式、错误原因。

## 4. 飞书 Gateway 接入总览

推荐默认方案：

```text
metaclaw gateway setup
  ↓
选择 Feishu / Lark
  ↓
扫码自动创建/注册 Bot
  ↓
保存 app_id / app_secret / domain
  ↓
默认选择 WebSocket
  ↓
配置 DM / group 访问策略
  ↓
metaclaw gateway run
  ↓
Feishu WebSocket 长连接接收事件
  ↓
MetaClaw Gateway 处理任务并回发结果
```

为什么优先 WebSocket：

- 不需要公网域名。
- 不需要 HTTPS 回调地址。
- 不需要内网穿透。
- 本地开发机、个人服务器、公司内网机器都能较快接入。
- 更符合“快捷进入飞书客户端”的目标。

Webhook 保留为企业部署选项：

- 需要公开可访问 URL。
- 需要 verification token / encrypt key。
- 需要安全网关、反向代理、防火墙配置。

## 5. 扫码注册 Bot 的完整流程

### 5.1 重要理解

扫码注册不是把个人飞书账号绑定成机器人。

扫码注册的本质是：

- MetaClaw 向飞书/Lark accounts registration endpoint 发起 device-code 风格注册。
- 用户用飞书/Lark 手机端扫码确认。
- 平台创建或授权一个 `PersonalAgent` 类型的 Bot 应用。
- MetaClaw 轮询注册结果。
- 成功后获得应用凭证：`client_id` 和 `client_secret`。
- `client_id` 对应 MetaClaw 配置里的 `FEISHU_APP_ID`。
- `client_secret` 对应 MetaClaw 配置里的 `FEISHU_APP_SECRET`。

这条路径参考 Hermes 的 `qr_register()` 实现。

### 5.2 涉及的域名

国内飞书：

```text
accounts base: https://accounts.feishu.cn
open base:     https://open.feishu.cn
domain:        feishu
```

国际 Lark：

```text
accounts base: https://accounts.larksuite.com
open base:     https://open.larksuite.com
domain:        lark
```

注册 endpoint：

```text
POST /oauth/v1/app/registration
Content-Type: application/x-www-form-urlencoded
```

### 5.3 Step 1：init 检查

MetaClaw CLI 先确认当前环境支持 `client_secret` 授权方式。

请求：

```http
POST https://accounts.feishu.cn/oauth/v1/app/registration
Content-Type: application/x-www-form-urlencoded

action=init
```

期望响应：

```json
{
  "supported_auth_methods": ["client_secret"]
}
```

处理：

- 如果响应里包含 `client_secret`，继续。
- 如果不包含，提示扫码注册不可用，进入手动 App ID / Secret 配置。
- 如果网络失败，提示重试或手动配置。

### 5.4 Step 2：begin 创建 device_code

请求：

```http
POST https://accounts.feishu.cn/oauth/v1/app/registration
Content-Type: application/x-www-form-urlencoded

action=begin
archetype=PersonalAgent
auth_method=client_secret
request_user_info=open_id
```

期望响应：

```json
{
  "device_code": "xxx",
  "verification_uri_complete": "https://...",
  "user_code": "ABCD-EFGH",
  "interval": 5,
  "expire_in": 600
}
```

MetaClaw 处理：

- 取 `device_code` 用于后续 poll。
- 取 `verification_uri_complete` 作为二维码 URL。
- 取 `interval` 作为轮询间隔，默认 5 秒。
- 取 `expire_in` 作为过期时间，默认 600 秒。
- 可以给 URL 附加来源参数，例如 `from=metaclaw&tp=metaclaw`。

### 5.5 Step 3：终端展示二维码

如果安装了 QR 渲染依赖，可在终端渲染二维码。

Node.js 可选方案：

- 使用 `qrcode-terminal`。
- 或不引入依赖，直接打印 URL。

推荐交互：

```text
正在连接 Feishu / Lark...

请用飞书手机端扫描下面二维码，或复制 URL 到手机端打开：

<ASCII QR Code>

URL:
https://...

等待扫码确认，最多 10 分钟...
```

注意：

- 二维码只用于创建/授权 Bot 应用。
- 不应在日志里保存完整 URL。
- 不应打印 app_secret，因为此时还没有拿到 app_secret。

### 5.6 Step 4：poll 轮询注册结果

请求：

```http
POST https://accounts.feishu.cn/oauth/v1/app/registration
Content-Type: application/x-www-form-urlencoded

action=poll
device_code=<device_code>
tp=ob_app
```

轮询规则：

- 按 `interval` 秒轮询。
- 直到 `expire_in` 超时。
- `authorization_pending` 继续等待。
- `access_denied` 用户拒绝，退出扫码流程。
- `expired_token` 过期，退出扫码流程。
- 网络短暂失败，等待后继续。

成功响应形态：

```json
{
  "client_id": "cli_xxx",
  "client_secret": "xxx",
  "user_info": {
    "open_id": "ou_xxx",
    "tenant_brand": "feishu"
  }
}
```

MetaClaw 保存：

- `client_id` -> `FEISHU_APP_ID`
- `client_secret` -> `FEISHU_APP_SECRET`
- `tenant_brand` -> `FEISHU_DOMAIN`
- `user_info.open_id` -> 可作为默认 allowlist 候选用户

Lark 自动识别：

- 如果 `tenant_brand = lark`，domain 切换为 `lark`。
- 后续 Open API base URL 使用 `https://open.larksuite.com`。

### 5.7 Step 5：probe bot 信息

拿到 app credentials 后，MetaClaw 应立即验证 Bot 可用。

请求流程：

1. 获取 tenant access token。

```http
POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal
Content-Type: application/json

{
  "app_id": "cli_xxx",
  "app_secret": "xxx"
}
```

2. 获取 bot 信息。

```http
GET https://open.feishu.cn/open-apis/bot/v3/info
Authorization: Bearer <tenant_access_token>
```

期望拿到：

```json
{
  "code": 0,
  "bot": {
    "app_name": "MetaClaw",
    "open_id": "ou_xxx"
  }
}
```

MetaClaw 使用：

- `bot_name` 用于 setup 显示。
- `bot_open_id` 用于群聊 @mention 判断。
- runtime 启动时还应再次 hydrate bot identity，防止配置过期。

### 5.8 Step 6：保存配置

推荐不要把 `app_secret` 明文写进 `config.yaml`。

推荐保存方式：

`~/.metaclaw/config.yaml`

```yaml
version: 1

gateway:
  enabled: true
  platforms:
    feishu:
      enabled: true
      domain: feishu
      connection_mode: websocket
      app_id: cli_xxx
      app_secret_env: FEISHU_APP_SECRET
      verification_token: ""
      event_port: 8787
      event_path: /feishu/events
      access:
        dm_policy: pairing
        allowed_users: []
        group_policy: open
        require_mention: true
      delivery:
        final_markdown_mode: card
        fallback_mode: post
        final_file_fallback: true
      home_channel: ""
```

`~/.metaclaw/.env`

```bash
FEISHU_APP_SECRET=xxx
FEISHU_DOMAIN=feishu
FEISHU_CONNECTION_MODE=websocket
FEISHU_ALLOW_ALL_USERS=false
FEISHU_ALLOWED_USERS=
FEISHU_GROUP_POLICY=open
```

历史 MetaClaw 配置只作为迁移来源：

```yaml
integrations:
  feishu:
    enabled: true
    mode: websocket
    app_id: cli_xxx
    app_secret_env: FEISHU_APP_SECRET
    event_port: 8787
    event_path: /feishu/events
    verification_token: ""
```

迁移要求：

- 启动时如果发现 `integrations.feishu.enabled: true` 且 `gateway.platforms.feishu` 尚未启用，自动迁移到 `gateway.platforms.feishu`。
- 迁移会保留 `mode/app_id/app_secret_env/event_port/event_path/verification_token`。
- 如果旧配置里有明文 `app_secret`，迁移到 `~/.metaclaw/.env` 的 `FEISHU_APP_SECRET`，不继续写在 `config.yaml`。
- 迁移完成后从 `config.yaml` 删除旧的 `integrations.feishu`，其他 `integrations` 项例如 `markdown_preview` 保持不变。
- 运行时短 fallback 只作为异常安全网；正常主路径必须读取新 Gateway 配置。
- 默认配置不再生成 `integrations.feishu`；该字段只允许作为历史文件迁移输入。

### 5.9 Step 7：配置访问策略

扫码完成后继续问用户：

```text
私聊 DM 如何授权？
1. pairing approval（推荐）
2. allow all
3. allowlist
```

推荐默认：

```yaml
dm_policy: pairing
```

但 MetaClaw 第一版可先用 allowlist 快速落地：

```yaml
dm_policy: allowlist
allowed_users:
  - ou_xxx
```

群聊策略：

```text
群聊如何处理？
1. 只在 @bot 时响应（推荐）
2. 禁用群聊
```

推荐默认：

```yaml
group_policy: open
require_mention: true
```

### 5.10 Step 8：启动 WebSocket Gateway

启动命令：

```bash
metaclaw gateway run
```

长期运行：

```bash
metaclaw gateway install
metaclaw gateway start
metaclaw gateway status
```

WebSocket 启动逻辑：

1. 加载 app_id/app_secret/domain。
2. 创建 Feishu app client。
3. 注册事件 dispatcher。
4. 创建 `WSClient`。
5. 调用 `start({ eventDispatcher })`。
6. 连接成功后写 runtime status。
7. 监听重连事件，写入 MetaClaw 系统日志。

当前 MetaClaw 已有类似逻辑在 `FeishuWebSocketBridge` 中，后续应迁移成 `FeishuGatewayAdapter`。

## 6. 飞书 WebSocket 运行时事件流

### 6.1 事件进入

飞书 WebSocket 收到 `im.message.receive_v1`。

原始事件包含：

- `message_id`
- `chat_id`
- `chat_type`
- `message_type`
- `content`
- `mentions`
- `sender.sender_id.open_id`
- `sender.sender_id.user_id`
- `sender.sender_id.union_id`

### 6.2 FeishuGatewayAdapter normalize

adapter 做平台解析：

- text/post/card 消息解析成文本。
- image/file/audio 下载到本地 cache。
- mentions 解析成 `GatewayMention[]`。
- bot mention 判断。
- sender 身份映射。
- chat 类型映射。

输出：

```ts
const event: GatewayInboundEvent = {
  id: 'feishu:om_xxx',
  platform: 'feishu',
  transport: 'websocket',
  messageId: 'om_xxx',
  chatId: 'oc_xxx',
  chatType: 'group',
  userId: 'ou_xxx',
  userName: '张三',
  text: '请帮我分析这份材料',
  messageType: 'text',
  attachments: [],
  mentions: [{ openId: 'ou_bot', isSelf: true }],
  raw,
  receivedAt: new Date().toISOString(),
};
```

### 6.3 GatewayPolicy admit

顺序：

1. `messageId` 去重。
2. self echo / bot loop 检查。
3. DM allowlist / pairing。
4. group policy。
5. group mention gate。
6. rate limit。

拒绝时：

- 默认不回复，避免噪音。
- pairing 场景可以发送一条短说明。
- admin debug 模式可记录原因。

### 6.4 GatewaySessionRouter submit

如果是文本：

```text
event.text + pending attachments
  ↓
MetaclawSession.submit(input, { awaitAsyncWork: true })
```

如果是文件：

- 下载到 `~/.metaclaw/gateway/feishu/uploads/<chat>/<message>/...`。
- 记录到 `GatewayResourceStore`。
- 回复短提示：“已收到文件，请继续发送任务说明。”

如果是 `/sethome`：

- 保存 `home_channel = chatId`。
- 回复设置成功。
- 不进入 TaskEngine。

如果是 `/status`：

- 返回 Gateway 和任务状态。
- 不进入普通任务执行。

### 6.5 进度投递

`MetaclawSession.subscribe()` 输出变化后：

- `GatewayProgressPublisher` 抽取核心进度。
- 通过 `GatewayDelivery` 发送 `kind=progress`。
- Feishu adapter 用短消息卡展示。

示例：

```markdown
**处理步骤**

- 任务已创建：调研飞书 Gateway 接入
- 记忆召回已跳过：无明确适用偏好
- 执行器路由：codex-cli
- 正在执行：构建方案文档
```

### 6.6 最终答案投递

任务完成后：

1. 从 session output 中抽取最终用户可见结果。
2. 过滤内部上下文。
3. 附加 Markdown preview links。
4. 分片。
5. 逐片发送 Feishu Markdown card。
6. 单片 card 失败则该片 fallback 到 post。
7. post 也失败则记录失败，并最终上传完整 Markdown 文件。
8. 上传 artifacts。

示例：

```text
finalAnswer
  ↓
splitForGateway(platform='feishu')
  ↓
send card chunk 1
send card chunk 2
send card chunk 3
  ↓
send artifacts
```

## 7. 飞书 Adapter 详细设计

### 7.1 文件结构

建议：

```text
src/gateway/platforms/feishu/
  adapter.ts
  client.ts
  onboarding.ts
  event-normalizer.ts
  message-renderer.ts
  access.ts
  types.ts
```

### 7.2 onboarding.ts

负责扫码注册。

核心函数：

```ts
export interface FeishuQrRegistrationResult {
  appId: string;
  appSecret: string;
  domain: 'feishu' | 'lark';
  userOpenId?: string;
  botName?: string;
  botOpenId?: string;
}

export async function registerFeishuBotByQr(options?: {
  initialDomain?: 'feishu' | 'lark';
  timeoutMs?: number;
  renderQr?: boolean;
}): Promise<FeishuQrRegistrationResult | null>;
```

内部步骤：

- `initRegistration(domain)`
- `beginRegistration(domain)`
- `renderQr(qrUrl)`
- `pollRegistration(deviceCode, interval, expireIn, domain)`
- `probeBot(appId, appSecret, domain)`

### 7.3 client.ts

负责飞书 API。

能力：

- `getTenantAccessToken()`
- `getBotInfo()`
- `sendMarkdownCard()`
- `sendPost()`
- `sendText()`
- `uploadFile()`
- `sendFile()`
- `downloadMessageResource()`
- `addReaction()`
- `removeReaction()`

注意：

- token 缓存要提前 5 分钟过期。
- send 方法必须返回 `message_id` 和错误详情。
- 不在日志中打印 app_secret / tenant token。

### 7.4 adapter.ts

负责 WebSocket/Webhook 生命周期。

```ts
export class FeishuGatewayAdapter implements GatewayPlatformAdapter {
  readonly platform = 'feishu' as const;

  async start(context: GatewayContext): Promise<void> {
    // load config
    // hydrate bot identity
    // build dispatcher
    // start websocket or webhook
  }

  async stop(): Promise<void> {
    // close websocket / server
    // flush dedup state
  }

  async send(target: GatewayTarget, message: GatewayOutboundMessage): Promise<GatewaySendResult> {
    // progress -> card
    // final -> markdown card chunks with fallback
    // notice/error -> short card/text
  }
}
```

### 7.5 event-normalizer.ts

负责 Feishu 原始事件到 `GatewayInboundEvent`。

关键处理：

- `message_type = text`：JSON content 取 `text`。
- `message_type = post`：遍历 rich text content，转换成 Markdown-ish 文本。
- `message_type = image/file/audio`：下载资源，生成 attachment。
- `mentions`：解析 `open_id/user_id/name`，标记 `isSelf`。
- `chat_type = p2p` -> `dm`。
- 其他 chat_type -> `group`。

### 7.6 message-renderer.ts

负责出站消息格式。

最终答案优先：

```text
interactive card
  body/elements: lark_md chunks
```

fallback：

```text
post
  zh_cn.content rows
```

最终兜底：

```text
upload file metaclaw-reply-<taskId>.md
send file message
```

## 8. setup 命令设计

### 8.1 命令

```bash
metaclaw gateway setup
```

交互：

```text
选择要配置的平台：
1. Feishu / Lark

如何配置 Feishu / Lark？
1. 扫码自动创建 Bot（推荐）
2. 手动输入 App ID / App Secret

连接模式：
1. WebSocket（推荐，无需公网地址）
2. Webhook（需要公网回调）

私聊授权：
1. Pairing approval（推荐）
2. Allow all
3. Allowlist

群聊策略：
1. 只在 @bot 时响应（推荐）
2. 禁用群聊

Home channel：
可选，后续也可在飞书里发送 /sethome
```

### 8.2 扫码成功后的 CLI 输出

```text
Feishu / Lark configured.

App ID: cli_xxx
Domain: feishu
Bot: MetaClaw
Connection mode: websocket
DM policy: pairing
Group policy: open, require mention

Next:
  metaclaw gateway run
```

### 8.3 手动配置 fallback

扫码失败时自动进入手动配置：

```text
二维码注册没有完成。你可以手动创建飞书应用：
1. 打开 https://open.feishu.cn/
2. 创建应用并启用 Bot
3. 开启事件订阅 im.message.receive_v1
4. 复制 App ID / App Secret
```

手动配置后仍应 probe bot。

## 9. 运行命令设计

建议补齐 Hermes 风格命令：

```bash
metaclaw gateway run
metaclaw gateway start
metaclaw gateway stop
metaclaw gateway restart
metaclaw gateway status
metaclaw gateway setup
```

现有命令兼容：

```bash
metaclaw --gateway
metaclaw --connect
./metaclaw.sh start
./metaclaw.sh connect
```

第一版可以保持 `--gateway`，新增子命令作为包装。

## 10. 配置迁移策略

当前 MetaClaw 配置：

```yaml
integrations:
  feishu:
    enabled: true
    mode: websocket
    app_id: cli_xxx
    app_secret_env: FEISHU_APP_SECRET
```

目标配置：

```yaml
gateway:
  enabled: true
  platforms:
    feishu:
      enabled: true
      domain: feishu
      connection_mode: websocket
      app_id: cli_xxx
      app_secret_env: FEISHU_APP_SECRET
```

自动迁移规则：

- 如果 `gateway.platforms.feishu` 存在，优先使用新配置。
- 如果 `gateway.platforms.feishu` 不存在或未启用，但 `integrations.feishu.enabled: true`，启动时自动写入新配置。
- 迁移成功后删除旧 `integrations.feishu`，避免旧架构长期并存。
- `mode` 映射到 `connection_mode`。
- `event_port/event_path/verification_token` 保持兼容。
- `app_secret` 仍允许作为历史输入；迁移时写入 `.env`，后续通过 `app_secret_env` 引用。
- 新的 setup/runtime 代码不得再写入 `integrations.feishu`。

## 11. 安全与审计

### 11.1 Secret 安全

- `app_secret` 不写入普通日志。
- `tenant_access_token` 不写入日志。
- `.env` 文件权限建议 `0600`。
- config 里默认只保存 `app_secret_env`。

### 11.2 入站审计

记录：

- platform
- message_id
- chat_id hash 或原值，取决于 privacy config
- user_id hash 或原值
- task_id
- admit/reject reason
- attachment local path

### 11.3 出站审计

记录：

- outbound kind
- task_id
- target chat_id
- chunk count
- chunk index
- send method: card/post/file
- success/error
- fallback 是否触发

这能直接回答“用户看到不完整时，到底哪一片失败、为什么失败”。

## 12. 测试方案

### 12.1 onboarding 单元测试

- init 成功。
- init 不支持 `client_secret`。
- begin 返回 device_code。
- poll `authorization_pending` 后成功。
- poll `access_denied`。
- poll `expired_token`。
- tenant_brand 从 `feishu` 切到 `lark`。
- probe bot 成功/失败。

### 12.2 Feishu adapter 测试

- WebSocket event normalize。
- 群聊未 @bot 被拒绝。
- 群聊 @bot 被接收。
- DM allowlist。
- message_id 去重。
- 文件消息缓存后附加到下一条文本。

### 12.3 Delivery 测试

- 最终答案用 Markdown card。
- 超长最终答案多卡片完整发送。
- 单片 card 失败，fallback post，后续片继续。
- card 和 post 都失败，上传完整 Markdown 文件。
- 不泄露 executor raw output / local path。

## 13. 分阶段实施建议

### Phase 1：快捷进入飞书客户端

目标：最短时间获得可用 Feishu Gateway。

实现：

- 新增 `metaclaw gateway setup`。
- 实现 Feishu QR onboarding。
- 保存配置和 `.env`。
- 复用当前 `FeishuWebSocketBridge`。
- 保持当前最终答案卡片发送和文件兜底逻辑。

不做：

- 不重写整个 Gateway runtime。
- 不支持 pairing。
- 不支持所有媒体类型。
- 不支持 service install。

### Phase 2：Gateway 抽象落地

目标：把 Feishu 从 integration 迁移到 Gateway platform adapter。

实现：

- 定义 `GatewayPlatformAdapter`。
- 定义 `GatewayInboundEvent`。
- Feishu event normalize。
- GatewayPolicy。
- GatewaySessionRouter。
- GatewayDelivery。

### Phase 3：生产化

目标：长期后台运行和多平台扩展。

实现：

- `gateway start/stop/restart/status`。
- pairing。
- `/sethome`。
- runtime status。
- audit log。
- webhook 安全增强。
- 新平台 adapter。

## 14. 最终推荐方案

MetaClaw 第一版飞书 Gateway 应采用：

```text
扫码注册 Bot
+ WebSocket 长连接
+ DM allowlist 或 pairing
+ 群聊 @mention 响应
+ 进度消息卡
+ 最终答案 Markdown 消息卡
+ 富文本 fallback
+ 完整 Markdown 文件兜底
```

用户路径：

```bash
metaclaw gateway setup
# 选择 Feishu / Lark
# 选择扫码自动创建 Bot
# 扫飞书二维码
# 默认 WebSocket
# 配置访问策略

metaclaw gateway run
```

飞书侧：

```text
私聊 MetaClaw Bot：
请帮我调研 XXX，并输出方案

群聊：
@MetaClaw 请总结今天的会议纪要
```

MetaClaw Gateway 返回：

```text
进度卡 1：任务已创建 / 记忆召回 / 队列
进度卡 2：执行器路由 / 正在执行
最终卡片 1..N：完整 Markdown 结果
文件消息：生成的 artifacts
```

这套方案既能快速接入飞书客户端，也为后续 Gateway 抽象、多平台接入、长期任务连续性和投递审计打下边界清晰的基础。

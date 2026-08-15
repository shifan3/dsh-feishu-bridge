# dsh-feishu-bridge

飞书（Feishu / Lark）桥接插件，用于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。

通过**飞书长连接（WebSocket）**接收机器人消息 → 交给一个拥有完整工具集的**常驻 Agent** 执行命令 → 再通过飞书机器人回复。不需要公网 IP / 域名 / 内网穿透，本机能访问公网即可。

## 架构

```
飞书用户 → 飞书云 ←WS 长连接→ helper.mjs(本地) --POST--> 插件路由 → 常驻 Agent(执行命令) → 飞书 API 回复
```

- `helper.mjs`：用官方 `@larksuiteoapi/node-sdk` 的 `WSClient` 主动外连飞书服务器，接收 `im.message.receive_v1` 事件。
- `index.js`：宿主插件，负责创建常驻 Agent、注册桥接路由、处理 `/` 命令、回发消息与 typing 指示器。

## 前置条件

- 已部署 DSH，并能以 `dsh web`（web profile）启动。
- 本机 Node.js ≥ 18（`fetch` / `WebSocket` 均可用）。
- 一个飞书**企业自建应用**（含机器人能力）。

## 第一步：配置飞书应用

1. 打开 [open.feishu.cn/app](https://open.feishu.cn/app) → 创建**企业自建应用** → 添加「**机器人**」能力。
2. 权限管理开启：`im:message`（获取与发送消息）、`im:message.p2p_msg`（单聊）、`im:message.group_at_msg`（群聊 @）、以及消息表情回复权限（`im:message.reaction`，用于 typing 指示器）。
3. 事件与回调 → 订阅事件 `im.message.receive_v1`，订阅方式选「**使用长连接接收事件**」。
4. 创建版本并**发布**（个人租户需管理员审批通过后机器人才生效）。
5. 在「凭证与基础信息」复制 **App ID** 和 **App Secret**。

## 第二步：安装插件

```bash
mkdir -p ~/.dsh/plugins
git clone https://github.com/<你的用户名>/dsh-feishu-bridge.git ~/.dsh/plugins/feishu-bridge
cd ~/.dsh/plugins/feishu-bridge
npm install
```

## 第三步：配置凭证（二选一）

**方式 A：环境变量（推荐）**

```bash
export FEISHU_APP_ID=cli_xxxxxxxx
export FEISHU_APP_SECRET=xxxxxxxx
```

**方式 B：本地 config.json（已 gitignore，不会进仓库）**

```bash
cp config.example.json config.json
# 编辑 config.json，填入 appId / appSecret / cwd（工作目录）等
```

> 凭证优先级：环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` > `config.json`。

## 第四步：挂载到 web profile

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，加入：

```yaml
- insert:
    - id: feishu-bridge
      name: '../../plugins/feishu-bridge/index.js'
```

重启 `dsh web` 即可生效。启动日志出现 `[feishu-bridge]` 与 `[feishu-helper]` 即表示加载成功。

## 内置命令

在飞书里直接发送：

| 命令 | 作用 |
|---|---|
| `/help` | 显示命令帮助 |
| `/new` | 新建会话 |
| `/reset` | 重置当前会话 |
| `/cd <路径>` | 切换 workspace（相对 / `~` / `/` 绝对路径） |
| `/status` | 当前状态 |
| `/context` | 当前上下文占用 |
| `/usage` | 本会话 API 用量（tokens） |
| `/skills` | 列出所有 skill |
| `/models` | 列出可用模型 |
| `/model [模型]` | 查看 / 切换模型 |
| `/effort [强度]` | 查看 / 切换思考强度 |
| `/mode [模式]` | 查看 / 切换模式（preset） |
| `/modes` | 列出可用模式 |

处理普通消息时，机器人会先在消息上显示 typing 表情，处理完成后移除。

## config.json 字段

| 字段 | 说明 | 默认 |
|---|---|---|
| `appId` | 飞书 App ID（也可用 `FEISHU_APP_ID`） | — |
| `appSecret` | 飞书 App Secret（也可用 `FEISHU_APP_SECRET`） | — |
| `presetId` | Agent 使用的 preset；`null` 为默认 | `null` |
| `cwd` | Agent 工作目录 | — |
| `groupReplyOnlyWhenMentioned` | 群聊仅被 @ 时回复 | `true` |
| `maxReplyChars` | 回复最大字符数 | `4000` |

## 安全说明

- 真实 App ID / Secret **不会**进入仓库：`config.json` 与 `.env` 已在 `.gitignore` 中，仓库只含 `config.example.json` 模板。
- 切换 workspace（`/cd`）会把该 Agent 的文件沙箱边界切换到新目录；`/cd` 到某目录即代表授权它在该目录下读写。

## License

MIT

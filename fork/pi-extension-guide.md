# Pi 二次开发指南

## 目录

- [扩展机制概览](#扩展机制概览)
- [TypeScript 扩展系统](#typescript-扩展系统)
- [扩展 API 参考](#扩展-api-参考)
- [事件系统](#事件系统)
- [自定义 Provider](#自定义-provider)
- [Skills 系统](#skills-系统)
- [Prompt 模板](#prompt-模板)
- [Themes 主题](#themes-主题)
- [npm/git 包分发](#npmgit-包分发)
- [SDK 编程接口](#sdk-编程接口)
- [RPC 模式](#rpc-模式)
- [扩展加载位置](#扩展加载位置)
- [配置系统](#配置系统)
- [示例参考](#示例参考)
- [二次开发最佳实践](#二次开发最佳实践)

---

## 扩展机制概览

Pi 项目设计了完善的扩展系统，支持在不修改源码的情况下进行二次开发。主要扩展机制：

1. **TypeScript 扩展** — 最核心的扩展方式，通过 `.ts` 文件注册工具、命令、Provider 等
2. **Skills** — 按需加载的能力包，用 `SKILL.md` 定义
3. **Prompt 模板** — Markdown 模板，支持参数化
4. **Themes** — JSON 主题色定义
5. **npm/git 包** — 可分发的扩展包
6. **SDK** — 编程方式嵌入 agent
7. **RPC 模式** — 供其他语言/进程集成

---

## TypeScript 扩展系统

扩展是 `.ts` 模块，导出一个工厂函数接收 `ExtensionAPI`：

```typescript
export default (pi: ExtensionAPI) => {
  // 注册工具
  pi.registerTool({
    name: "my-tool",
    description: "我的自定义工具",
    parameters: { /* JSON Schema */ },
    execute: async (params, ctx) => {
      return { result: "..." };
    },
  });

  // 注册命令
  pi.registerCommand("my-cmd", {
    description: "我的自定义命令",
    execute: async (ctx) => {
      // 命令逻辑
    },
  });
};
```

### 扩展加载位置（不改源码）

| 位置 | 作用域 |
|------|--------|
| `~/.pi/agent/extensions/*.ts` | 全局（所有项目） |
| `~/.pi/agent/extensions/*/index.ts` | 全局（子目录） |
| `.pi/extensions/*.ts` | 项目级 |
| `.pi/extensions/*/index.ts` | 项目级（子目录） |
| `settings.json` `extensions` 数组 | 自定义路径 |
| CLI `--extension` / `-e` 参数 | 一次性加载（含 npm/git 包） |

---

## 扩展 API 参考

### ExtensionAPI (`pi`)

**事件系统：**
- `pi.on(event, handler)` — 订阅生命周期事件

**工具注册：**
- `pi.registerTool(definition)` — 注册 LLM 可调用的自定义工具
- `pi.setActiveTools(names)` — 运行时启用/禁用工具

**命令注册：**
- `pi.registerCommand(name, options)` — 注册斜杠命令（如 `/mycommand`）

**Provider 注册：**
- `pi.registerProvider(name, config)` — 注册自定义 LLM Provider
- `pi.unregisterProvider(name)` — 移除已注册的 Provider

**消息注入：**
- `pi.sendMessage(message, options)` — 向会话注入自定义消息
- `pi.sendUserMessage(content, options)` — 向 agent 发送用户消息

**状态管理：**
- `pi.appendEntry(customType, data)` — 在会话中持久化扩展状态
- `pi.setSessionName(name)` — 设置会话显示名称
- `pi.setLabel(entryId, label)` — 设置/清除条目标签

**UI 注册：**
- `pi.registerMessageRenderer(customType, renderer)` — 自定义 TUI 消息渲染
- `pi.registerShortcut(shortcut, options)` — 注册键盘快捷键
- `pi.registerFlag(name, options)` — 注册 CLI 标志

**执行：**
- `pi.exec(command, args, options)` — 执行 shell 命令
- `pi.events` — 扩展间事件总线（`emit`/`on`）

### ExtensionContext (`ctx`)

所有处理器接收的上下文对象：

- `ctx.ui` — 用户交互方法（confirm、select、input、notify、setStatus、setWidget、setHeader、setFooter、setEditorText、setEditorComponent、setWorkingIndicator、setHiddenThinkingLabel）
- `ctx.hasUI` — 是否有 UI（print/JSON 模式下为 false）
- `ctx.cwd` — 当前工作目录
- `ctx.sessionManager` — 只读会话状态访问
- `ctx.modelRegistry` / `ctx.model` — 模型和 API Key 访问
- `ctx.signal` — 当前 agent 中止信号
- `ctx.isIdle()` / `ctx.abort()` / `ctx.hasPendingMessages()` — 控制流
- `ctx.shutdown()` — 优雅关闭
- `ctx.getContextUsage()` — 当前上下文使用量
- `ctx.compact()` — 触发压缩
- `ctx.getSystemPrompt()` — 当前系统提示

### ExtensionCommandContext

继承 `ExtensionContext`，命令中可用的额外方法：

- `ctx.waitForIdle()` — 等待 agent 完成流式输出
- `ctx.newSession(options)` — 创建新会话
- `ctx.fork(entryId, options)` — 从指定条目分叉
- `ctx.navigateTree(targetId, options)` — 导航会话树
- `ctx.switchSession(sessionPath, options)` — 切换会话
- `ctx.reload()` — 重新加载扩展、技能、提示、主题

---

## 事件系统

### 生命周期事件

| 事件 | 说明 |
|------|------|
| `session_start` | 会话启动/加载/重载 |
| `session_shutdown` | 扩展运行时被拆除 |
| `session_before_switch` | `/new` 或 `/resume` 之前（可取消） |
| `session_before_fork` | `/fork` 或 `/clone` 之前（可取消） |
| `session_before_compact` | 压缩之前（可取消或自定义） |
| `session_compact` | 压缩之后 |
| `session_before_tree` | `/tree` 导航之前（可取消或自定义） |
| `session_tree` | 树导航之后 |

### 资源事件

| 事件 | 说明 |
|------|------|
| `resources_discover` | 贡献技能、提示、主题路径 |

### Agent 事件

| 事件 | 说明 |
|------|------|
| `before_agent_start` | 可注入消息和修改系统提示 |
| `agent_start` / `agent_end` | 每次提示的生命周期 |
| `turn_start` / `turn_end` | 每轮的生命周期 |
| `message_start` / `message_update` / `message_end` | 消息生命周期 |
| `context` | 每次 LLM 调用前，可修改消息 |

### 工具事件

| 事件 | 说明 |
|------|------|
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | 工具执行生命周期 |
| `tool_call` | 工具执行前（**可阻止**） |
| `tool_result` | 工具执行后（**可修改结果**） |

### Provider 事件

| 事件 | 说明 |
|------|------|
| `before_provider_request` | 检查/替换 Provider 负载 |
| `after_provider_response` | HTTP 响应头/状态 |

### 输入事件

| 事件 | 说明 |
|------|------|
| `input` | 拦截/转换用户输入 |
| `user_bash` | 拦截 `!`/`!!` 命令 |

### 模型事件

| 事件 | 说明 |
|------|------|
| `model_select` | 模型切换 |
| `thinking_level_select` | 思考级别切换 |

---

## 自定义 Provider

### Provider 注册

```typescript
pi.registerProvider("my-provider", {
  name: "My Provider",
  baseUrl: "https://api.example.com",
  apiKey: "MY_API_KEY",          // 环境变量名或字面量
  api: "openai-completions",     // 流式 API 类型
  models: [...],
  streamCustom?: streamFunction,  // 自定义流式实现
  oauth?: { ... },               // OAuth/SSO 支持
  headers?: { ... },
  authHeader?: boolean,
});
```

### 支持的 API 类型

- `anthropic-messages`
- `openai-completions`
- `openai-responses`
- `azure-openai-responses`
- `openai-codex-responses`
- `mistral-conversations`
- `google-generative-ai`
- `google-vertex`
- `bedrock-converse-stream`

### 自定义流式实现

对于非标准 API，参考 `packages/ai/src/providers/` 中的模式实现 `streamSimple`。

### OAuth 支持

完整的 OAuth/SSO 集成，包含 `login()`、`refreshToken()`、`getApiKey()`、`modifyModels()` 回调。

---

## Skills 系统

Skills 是按需加载的能力包。

### 目录结构

```
my-skill/
  SKILL.md        # 必需：前置元数据 + 指令
  scripts/        # 辅助脚本
  references/     # 详细文档
  assets/         # 模板等
```

### 加载位置

- 全局：`~/.pi/agent/skills/`、`~/.agents/skills/`
- 项目：`.pi/skills/`、`.agents/skills/`
- 包：`skills/` 目录或 `package.json` 中的 `pi.skills`
- 设置：`skills` 数组
- CLI：`--skill <path>`

### 加载流程

1. 启动时扫描位置，提取名称/描述
2. 系统提示包含可用技能（XML 格式）
3. Agent 按需使用 `read` 加载完整 `SKILL.md`
4. 命令：`/skill:name` 强制加载

---

## Prompt 模板

Markdown 片段，展开为完整提示。

### 模板位置

- 全局：`~/.pi/agent/prompts/*.md`
- 项目：`.pi/prompts/*.md`
- 包：`prompts/` 目录或 `package.json` 中的 `pi.prompts`
- 设置：`prompts` 数组
- CLI：`--prompt-template <path>`

### 模板格式

```markdown
---
description: Review staged git changes
argument-hint: "<PR-URL>"
---
Review the staged changes (`git diff --cached`). Focus on: ...
```

### 参数

- `$1`、`$2`、... — 位置参数
- `$@` 或 `$ARGUMENTS` — 所有参数
- `${@:N}` — 从位置 N 开始的参数
- `${@:N:L}` — 从位置 N 开始的 L 个参数

---

## Themes 主题

JSON 文件定义 TUI 颜色。

### 主题位置

- 内置：`dark`、`light`
- 全局：`~/.pi/agent/themes/*.json`
- 项目：`.pi/themes/*.json`
- 包：`themes/` 目录或 `package.json` 中的 `pi.themes`
- 设置：`themes` 数组
- CLI：`--theme <path>`

### 主题格式

包含 51 个必需的颜色标记，覆盖 UI、Markdown、语法高亮、思考级别和工具 diff。

---

## npm/git 包分发

扩展可以打包为 npm 或 git 包分发。

### 包清单 (`package.json`)

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

### 包来源

- `npm:@scope/pkg@version`
- `git:github.com/user/repo@ref`
- 本地路径（绝对或相对）

### 包管理命令

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi remove npm:@foo/bar
pi list
pi update
```

---

## SDK 编程接口

SDK 提供不依赖 CLI 的编程访问。

### 主要导出（`@earendil-works/pi-coding-agent`）

- `createAgentSession()` — 单会话工厂
- `createAgentSessionRuntime()` — 可替换会话的工厂
- `createAgentSessionServices()` — 为 runtime 创建服务
- `createAgentSessionFromServices()` — 从服务创建会话
- `SessionManager` — 会话持久化
- `SettingsManager` — 设置管理
- `AuthStorage` — API Key/OAuth 存储
- `ModelRegistry` — 模型发现
- `DefaultResourceLoader` — 扩展/技能/提示/主题加载
- `createEventBus()` — 扩展间通信
- `defineTool()` — 独立工具定义
- 工具工厂：`createCodingTools`、`createReadOnlyTools`、`createReadTool`、`createBashTool` 等

### SDK 示例

`examples/sdk/01-minimal.ts` 到 `13-session-runtime.ts` — 渐进式示例。

---

## RPC 模式

JSON-RPC 协议，用于子进程集成。

```bash
pi --mode rpc [options]
```

### 命令

`prompt`、`steer`、`follow_up`、`abort`、`set_model`、`set_thinking_level`、`get_commands`、`get_tools`、`get_state`、`get_session_info`、`navigate_tree`、`fork`、`new_session`、`switch_session`、`compact`、`reload`、`set_compaction`、`list_sessions`、`shutdown`、`ping`

### 扩展 UI 协议

`notify`、`confirm`、`select`、`input`、`editor`、`set_status`、`set_widget`、`set_footer`、`set_header`、`set_editor_text`、`set_editor_component`、`set_hidden_thinking_label`、`set_working_indicator`、`set_title`

---

## 配置系统

### `.pi/` 目录结构

```
.pi/
  extensions/     # 项目级扩展
  skills/         # 项目级技能
  prompts/        # 项目级提示模板
  settings.json   # 项目设置（覆盖全局）
  npm/            # 项目级 npm 包
  git/            # 项目级 git 包
```

### 全局配置 (`~/.pi/agent/`)

```
~/.pi/agent/
  settings.json   # 全局设置
  extensions/     # 全局扩展
  skills/         # 全局技能
  prompts/        # 全局提示
  themes/         # 全局主题
  auth.json       # API Key 和 OAuth Token
  models.json     # 自定义模型定义
  sessions/       # 会话存储
  npm/            # 全局 npm 包
  git/            # 全局 git 包
  agents/         # 子 agent 定义
```

### settings.json 扩展相关设置

```json
{
  "extensions": ["/path/to/extension.ts"],
  "skills": ["/path/to/skills"],
  "prompts": ["/path/to/prompts"],
  "themes": ["/path/to/themes"],
  "packages": ["npm:@foo/bar@1.0.0", "git:github.com/user/repo@v1"]
}
```

---

## 示例参考

`packages/coding-agent/examples/extensions/` 下有 **73 个示例**：

### 安全与权限

- `permission-gate.ts` — 权限门控
- `protected-paths.ts` — 路径保护
- `confirm-destructive.ts` — 破坏性操作确认
- `dirty-repo-guard.ts` — 脏仓库保护
- `sandbox/` — 沙箱环境

### 自定义工具

- `hello.ts` — 基础示例
- `todo.ts` — 待办事项
- `question.ts` / `questionnaire.ts` — 问答
- `tool-override.ts` — 工具覆盖
- `dynamic-tools.ts` — 动态工具
- `structured-output.ts` — 结构化输出
- `minimal-mode.ts` — 最小模式
- `ssh.ts` — SSH 集成
- `subagent/` — 子 agent

### 命令与 UI

- `preset.ts` — 预设
- `plan-mode/` — 计划模式
- `tools.ts` — 工具管理
- `handoff.ts` — 交接
- `status-line.ts` — 状态栏
- `github-issue-autocomplete.ts` — GitHub Issue 自动补全
- `widget-placement.ts` — 组件放置
- `snake.ts` / `tic-tac-toe.ts` — 游戏示例
- `modal-editor.ts` — 模态编辑器
- `rpc-demo.ts` — RPC 演示
- `interactive-shell.ts` — 交互式 Shell
- `inline-bash.ts` — 内联 Bash

### Git 集成

- `git-checkpoint.ts` — Git 检查点
- `auto-commit-on-exit.ts` — 退出时自动提交

### 系统提示与压缩

- `pirate.ts` — 海盗风格
- `claude-rules.ts` — Claude 规则
- `custom-compaction.ts` — 自定义压缩

### 自定义 Provider

- `custom-provider-anthropic/` — 自定义 Anthropic + OAuth
- `custom-provider-gitlab-duo/` — GitLab Duo 代理

---

## 二次开发最佳实践

### 推荐方式

1. **扩展放在 `.pi/extensions/` 或打包成 npm 包**
2. **不修改上游任何代码**
3. **随时 `git pull` 更新上游**
4. **扩展独立维护，放在自己的仓库**
5. **通过 `settings.json` 或 npm 包机制加载**

### 扩展包结构

```
my-pi-extension/
  package.json          # 包含 "pi" 字段
  extensions/
    my-tool.ts
    my-command.ts
  skills/
    my-skill/
      SKILL.md
  prompts/
    my-prompt.md
  themes/
    my-theme.json
```

### package.json 示例

```json
{
  "name": "my-pi-extension",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "^0.75.5"
  }
}
```

### 安装自定义扩展

```bash
# npm 包
pi install npm:my-pi-extension@1.0.0

# git 仓库
pi install git:github.com/user/my-pi-extension@v1

# 本地路径
pi install /path/to/my-pi-extension
```

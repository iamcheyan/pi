# pi-debug 架构文档

## pi 主程序任务处理机制

### 核心概念

pi 使用**单 agent loop + 双队列**架构。所有用户输入都在同一个 agent loop 中串行处理，**不会启动新的子代理**。

### 两种消息队列

| 队列 | 触发方式 | 执行时机 | 用途 |
|------|---------|---------|------|
| **Steering** | Enter 发送 | 当前 tool call 完成后，下一个 LLM 调用前 | "插嘴" — 立即影响 AI 决策 |
| **Follow-up** | Alt+Enter 发送 | 当前轮次所有 tool call 完成后 | "排队" — 等当前任务结束再执行 |

### 执行流程

```
用户输入
  ↓
┌─ Agent 正在运行？─┐
│                   │
│  NO               YES
│  ↓                ↓
│  直接执行      ┌─ 入队 ─────────────────────────┐
│               │                                 │
│               │  Enter → Steering 队列           │
│               │  Alt+Enter → Follow-up 队列      │
│               │                                 │
│               │  Agent loop 按顺序处理：         │
│               │  1. 处理当前 tool call           │
│               │  2. 注入 steering 消息           │
│               │  3. 下一次 LLM 调用              │
│               │  4. 重复直到无 tool call          │
│               │  5. 处理 follow-up 消息          │
│               └─────────────────────────────────┘
```

### 关键代码路径

1. **消息入队**: `agent-session.ts:1027-1041`
   - 检测 `isStreaming` 状态
   - 根据 `streamingBehavior` 选择队列

2. **队列实现**: `agent-session.ts:1240-1269`
   - `_queueSteer()`: 加入 steering 队列
   - `_queueFollowUp()`: 加入 follow-up 队列

3. **队列消费**: `agent-loop.ts:166-260`
   - 内层循环处理 steering（在 tool call 之间）
   - 外层循环处理 follow-up（在 agent 停止后）

4. **队列模式**: `agent.ts:109-110, 212-213`
   - `steeringMode`: "one-at-a-time" | "all"
   - `followUpMode`: "one-at-a-time" | "all"
   - "one-at-a-time" 只保留最新一条，"all" 保留所有

### 队列模式详解

```typescript
// agent.ts:126-143
class PendingMessageQueue {
  enqueue(message: AgentMessage): void {
    if (this.mode === "one-at-a-time") {
      // 覆盖之前的待处理消息
      this.messages = [message];
    } else {
      // 保留所有消息
      this.messages.push(message);
    }
  }
  
  drain(): AgentMessage[] {
    const drained = this.messages.slice();
    this.messages = [];
    return drained;
  }
}
```

### 用户可见的队列状态

UI 会显示当前队列中的消息数量：
- `hint("app.message.followUp", "to queue follow-up")` — 提示 Alt+Enter 排队
- `hint("app.message.dequeue", "to edit all queued messages")` — 提示可以编辑队列

### 扩展命令的特殊处理

扩展命令（以 `/` 开头）**不能入队**，会立即执行：

```typescript
// agent-session.ts:1274-1283
_throwIfExtensionCommand(text: string): void {
  const commandName = text.slice(1, text.indexOf(" "));
  const command = this._extensionRunner.getCommand(commandName);
  if (command) {
    throw new Error(
      `Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`
    );
  }
}
```

### Compaction（压缩）期间的队列

当 agent 正在进行 compaction（上下文压缩）时，消息会被暂存：

```typescript
// interactive-mode.ts:337
// Messages queued while compaction is running
this.compactionQueuedMessages: Array<{text: string, mode: "steer" | "followUp"}> = [];
```

### 与 pi-debug 的关系

pi-debug 的扩展运行在主 session 的 agent loop 中。当 worker 在执行时：
- 用户的 Enter 输入会进入 Steering 队列
- 用户的 Alt+Enter 输入会进入 Follow-up 队列
- **不会**启动新的子代理来处理用户输入

如果需要并发执行，扩展必须自己 spawn 独立的 pi 进程（如 ralph 的 worker 模式）。

---

## 并发执行机制

### Subagent 工具

pi 提供了 `subagent` 工具，允许 AI 调用它来并行执行任务。每个 subagent 是独立的 pi 进程。

**三种模式**：

| 模式 | 参数 | 并发限制 | 用途 |
|------|------|---------|------|
| Single | `{ agent, task }` | 1 | 单个任务 |
| Parallel | `{ tasks: [...] }` | 最多 8 个，4 个并发 | 并行执行多个独立任务 |
| Chain | `{ chain: [...] }` | 串行 | 链式执行，上一步输出传给下一步 |

**示例**：

```json
// 并行执行
{
  "tasks": [
    { "agent": "stylist", "task": "调整样式" },
    { "agent": "linter", "task": "格式化代码" },
    { "agent": "tester", "task": "写测试" }
  ]
}

// 链式执行
{
  "chain": [
    { "agent": "analyst", "task": "分析问题" },
    { "agent": "coder", "task": "修复 {previous} 中的问题" }
  ]
}
```

### /spawn 命令（pi-spawn 扩展）

`/spawn` 是独立的 pi-spawn 扩展，允许用户直接启动 subagent。

**安装**：在 `settings.json` 的 `packages` 中添加 pi-spawn 路径。

**用法**：

```
/spawn <task>                    # 使用默认 worker agent
/spawn <agent> <task>            # 使用指定 agent
/spawn --list                    # 列出可用 agents
/spawn --status                  # 查看运行中的 subagents
/spawn --kill <id>               # 终止运行中的 subagent
```

**示例**：

```
/spawn 修复登录页面的样式问题
/spawn reviewer 检查最新的提交
/spawn scout 搜索所有 API 端点
```

**特点**：
- 启动后立即返回，不阻塞主 session
- 可以同时运行多个 subagent
- 使用 `/spawn --status` 查看进度
- 每个 subagent 是独立的 pi 进程，有隔离的上下文
- 与 pi-debug 完全独立，互不依赖

### Agent 定义

Agent 是 markdown 文件，定义在：
- `~/.pi/agent/agents/*.md` — 用户级（始终加载）
- `.pi/agents/*.md` — 项目级（需要 `agentScope: "both"`）

**示例 agent 定义**：

```markdown
---
name: worker
description: General-purpose worker agent
tools: read, grep, find, ls, bash, edit, write
model: claude-sonnet-4-6
---

You are a general-purpose worker agent. Execute the task efficiently.
```

### 并发 vs 串行 对比

| | 主 Session | Subagent (AI 调用) | /spawn (pi-spawn 扩展) |
|---|---|---|---|
| **并发** | ❌ 串行 | ✅ 并行（最多 4 个） | ✅ 并行（无限制） |
| **上下文** | 共享完整上下文 | 隔离的独立上下文 | 隔离的独立上下文 |
| **用户交互** | 直接对话 | 不能直接交互 | 不能直接交互 |
| **启动方式** | 自然对话 | AI 调用 subagent 工具 | 用户输入 /spawn 命令 |
| **安装** | 内置 | 内置 | 独立扩展包 |
| **适用场景** | 需要上下文的任务 | AI 识别可并行的任务 | 用户明确指定并行任务 |

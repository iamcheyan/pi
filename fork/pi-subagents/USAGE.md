# pi-subagents 使用手册

> npm 版本的 `pi-subagents`，功能比源码 example 版本更丰富。

---

## 目录

- [安装与配置](#安装与配置)
- [核心概念](#核心概念)
- [斜杠命令](#斜杠命令)
- [内置 Agent](#内置-agent)
- [内置 Prompt 模板](#内置-prompt-模板)
- [Agent 定义格式](#agent-定义格式)
- [Chain 文件](#chain-文件)
- [配置选项](#配置选项)
- [安全模型](#安全模型)
- [故障排查](#故障排查)

---

## 安装与配置

### 安装

```bash
pi install npm:pi-subagents
```

### 安装 Prompt 模板

npm 包的 prompt 模板放在 `node_modules` 里，pi 的 prompt 发现系统不会自动扫描那里。需要手动 symlink：

```bash
mkdir -p ~/.pi/agent/prompts
for f in ~/.pi/agent/npm/node_modules/pi-subagents/prompts/*.md; do
  ln -sf "$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

### 安装 Agent 定义（可选）

内置 agent 由扩展自动加载，但如果你想自定义或覆盖，可以 symlink 到 agents 目录：

```bash
mkdir -p ~/.pi/agent/agents
for f in ~/.pi/agent/npm/node_modules/pi-subagents/agents/*.md; do
  ln -sf "$f" ~/.pi/agent/agents/$(basename "$f")
done
```

### 检查安装

```
/subagents-doctor
```

或者自然语言：

```
检查 subagents 是否配置正确
```

---

## 核心概念

- **父会话**：你正在用的 pi 主会话
- **子代理（subagent）**：一个独立的 pi 进程，有自己的上下文窗口
- 子代理的结果会返回给父会话
- 支持前台（流式输出）和后台（异步执行）两种模式

---

## 斜杠命令

### 单代理：`/run`

```
/run <agent> [task] [--bg] [--fork]
```

示例：

```
/run scout "找到所有数据库相关代码"
/run reviewer "review 这个 diff"
/run oracle "对这个方案给个第二意见"
/run worker "给 session store 添加 Redis 缓存" --bg
```

### 链式执行：`/chain`

```
/chain agent1 "task1" -> agent2 "task2" [--bg] [--fork]
```

示例：

```
/chain scout "扫描认证代码" -> planner "制定实现计划" -> worker "执行实现"
```

链中可用 `{previous}` 占位符引用上一步输出（自动替换）。

### 并行执行：`/parallel`

```
/parallel agent1 "task1" -> agent2 "task2" [--bg] [--fork]
```

示例：

```
/parallel reviewer "检查正确性" -> reviewer "检查测试覆盖" -> reviewer "检查代码简洁性"
```

### 运行保存的 Chain：`/run-chain`

```
/run-chain <chainName> -- <task> [--bg] [--fork]
```

### 内联配置

在 agent 名后用 `[key=value]` 覆盖该步配置：

```
/run reviewer[model=anthropic/claude-sonnet-4] "review 这个 diff"
/chain scout[output=context.md] "扫描代码" -> planner[reads=context.md] "分析"
```

可用 key：

| Key | 示例 | 说明 |
|-----|------|------|
| `output` | `output=context.md` | 结果写入文件 |
| `outputMode` | `outputMode=file-only` | 只返回文件引用 |
| `reads` | `reads=a.md+b.md` | 执行前读取文件 |
| `model` | `model=anthropic/claude-sonnet-4` | 覆盖模型 |
| `skills` | `skills=planning+review` | 覆盖注入的 skills |
| `progress` | `progress` | 启用进度追踪 |

### 后台执行

加 `--bg`：

```
/run scout "审计整个代码库" --bg
/chain scout -> planner -> worker --bg
```

### Fork 模式

加 `--fork` 从当前会话分支创建子会话：

```
/run reviewer "review 这个 diff" --fork
/chain scout -> planner -> worker --fork
```

---

## 内置 Agent

| Agent | 用途 | 推荐场景 |
|-------|------|----------|
| `scout` | 快速代码侦察，返回压缩上下文 | 不了解代码时先用它 |
| `researcher` | 网络/文档调研，返回来源和摘要 | 需要查外部资料 |
| `planner` | 从上下文制定实现计划（只读） | 大改动前先规划 |
| `worker` | 通用实现代理，全工具权限 | 执行计划、实现功能 |
| `reviewer` | 代码审查，检查质量/安全/可维护性 | 检查实现质量 |
| `oracle` | 第二意见，挑战假设、发现盲点 | 重大决策前咨询 |
| `context-builder` | 收集上下文，写交接材料 | 复杂任务的准备工作 |
| `delegate` | 轻量通用代理，行为接近父会话 | 简单委托 |

### 使用经验

- **不了解代码** → 先 `scout`
- **需要外部信息** → 用 `researcher`
- **大改动** → `scout` → `planner` → `worker`
- **实现后** → `reviewer` 检查
- **重大决策** → 先问 `oracle`
- **审查循环** → `worker` → `reviewer` → `worker`（直到干净）

---

## 内置 Prompt 模板

symlink 后可直接使用：

| 命令 | 用途 |
|------|------|
| `/parallel-review` | 多角度并行审查，然后综合修复建议 |
| `/review-loop` | worker → reviewer → worker 循环直到干净 |
| `/parallel-research` | researcher + scout 并行调研外部和本地信息 |
| `/parallel-context-build` | 多个 context-builder 并行收集上下文 |
| `/parallel-handoff-plan` | 外部调研 + context-builder 合成交接计划 |
| `/gather-context-and-clarify` | 先侦察/调研，再问用户澄清问题 |
| `/parallel-cleanup` | 实现后的纯审查清理 |

---

## 自然语言用法

不需要记命令，直接用自然语言即可：

```
用 reviewer review 一下刚才的改动
```

```
用 scout 先了解一下认证流程，然后让 planner 制定重构方案
```

```
让 oracle 对当前方案提个第二意见，挑战一下假设
```

```
同时跑 3 个 reviewer：一个检查正确性，一个检查测试，一个检查简洁性
```

```
实现这个方案，然后跑 reviewer 审查，根据反馈修改
```

```
跑一个 review loop 直到审查通过，最多 3 轮
```

```
后台跑这个审计任务
```

```
显示当前有哪些活跃的后台任务
```

---

## Agent 定义格式

Agent 是带 YAML frontmatter 的 markdown 文件：

```markdown
---
name: my-agent
description: 做某件事
tools: read, grep, find, ls
model: claude-sonnet-4
fallbackModels: openai/gpt-5-mini, anthropic/claude-haiku-4-5
thinking: high
systemPromptMode: replace
inheritProjectContext: false
inheritSkills: false
skills: safe-bash
output: context.md
defaultReads: context.md
defaultProgress: true
completionGuard: false
maxSubagentDepth: 1
---

你的系统提示词写在这里。
```

### Frontmatter 字段

| 字段 | 说明 |
|------|------|
| `name`（必需） | 代理名称 |
| `description`（必需） | 一句话描述 |
| `tools` | 逗号分隔的工具白名单，省略则继承全部 |
| `model` | 默认模型 |
| `fallbackModels` | 备用模型，按优先级排序 |
| `thinking` | 思考级别 |
| `systemPromptMode` | `replace`（默认）或 `append`（保留基础提示） |
| `inheritProjectContext` | 是否继承项目指令文件 |
| `inheritSkills` | 是否继承 skills 目录 |
| `defaultContext` | `fresh` 或 `fork` |
| `skills` | 注入特定 skills |
| `output` | 默认输出文件 |
| `defaultReads` | 执行前读取的文件 |
| `defaultProgress` | 是否维护 progress.md |
| `completionGuard` | 只读代理设为 `false` |
| `maxSubagentDepth` | 限制嵌套子代理深度 |

### Agent 发现优先级

从低到高：

1. 内置（扩展自带）
2. 用户级：`~/.pi/agent/agents/**/*.md`
3. 项目级：`.pi/agents/**/*.md`

同名 agent，高优先级覆盖低优先级。

---

## Chain 文件

可复用的 `.chain.md` 工作流文件。

存放位置：
- 用户级：`~/.pi/agent/chains/**/*.chain.md`
- 项目级：`.pi/chains/**/*.chain.md`

示例：

```markdown
---
name: scout-planner
description: 收集上下文然后制定实现计划
---

## scout
output: context.md

分析 {task} 的代码

## planner
reads: context.md
model: anthropic/claude-sonnet-4-5

基于 {previous} 制定实现计划
```

每个 `## agent-name` 是一步。配置行（`output`、`reads`、`model` 等）紧跟 header，空行后是任务文本。

运行：

```
/run-chain scout-planner -- 重构认证模块
```

### Chain 变量

| 变量 | 说明 |
|------|------|
| `{task}` | 第一步的原始任务 |
| `{previous}` | 上一步的输出 |
| `{chain_dir}` | chain 产物目录路径 |

---

## 配置选项

配置文件：`~/.pi/agent/extensions/subagent/config.json`

### 全部默认后台执行

```json
{ "asyncByDefault": true }
```

### 强制顶层后台

```json
{ "forceTopLevelAsync": true }
```

### 并行参数

```json
{
  "parallel": {
    "maxTasks": 12,
    "concurrency": 6
  }
}
```

默认：maxTasks=8, concurrency=4。

### 嵌套深度限制

```json
{ "maxSubagentDepth": 1 }
```

或环境变量：

```bash
export PI_SUBAGENT_MAX_DEPTH=3
```

### Intercom 桥接

```json
{
  "intercomBridge": {
    "mode": "always",
    "instructionFile": "./intercom-bridge.md"
  }
}
```

需要额外安装 `pi-intercom`。

### Worktree 隔离

```json
{
  "worktreeSetupHook": "./scripts/setup-worktree.mjs",
  "worktreeSetupHookTimeoutMs": 45000
}
```

---

## 安全模型

- 默认只加载用户级 agent（`~/.pi/agent/agents/`）
- 项目级 agent（`.pi/agents/`）需要显式启用 `agentScope: "both"`
- 加载项目级 agent 前会弹出确认对话框
- 子代理默认不能调用 `subagent` 工具（除非明确授权 `tools: subagent`）
- 嵌套深度有上限保护

---

## 自定义 Agent 示例

创建 `~/.pi/agent/agents/security-auditor.md`：

```markdown
---
name: security-auditor
description: 专注于安全审计的代理
tools: read, grep, find, ls, bash
model: claude-sonnet-4
systemPromptMode: replace
inheritProjectContext: true
---

你是一个安全审计专家。分析代码中的安全漏洞、常见攻击面和最佳实践违反。

## 输出格式

## 发现的问题
- `file:line` - 问题描述（严重性）

## 建议修复
具体修复方案

## 总结
整体安全评估
```

使用：

```
/run security-auditor "审计整个项目的安全问题"
```

---

## 故障排查

```
/subagents-doctor
```

或：

```
检查 subagents 和 intercom 是否配置正确
```

常见问题：

1. **`/run` 命令不识别** → 检查扩展是否加载：`~/.pi/agent/extensions/` 下应有 `subagent` 相关文件
2. **agent 找不到** → 检查 `~/.pi/agent/agents/` 目录
3. **prompt 模板不生效** → 检查 `~/.pi/agent/prompts/` 目录是否 symlink 了
4. **后台任务不通知** → 可能需要安装 `pi-intercom`

---

## 程序化调用（高级）

LLM 调用 `subagent` 工具时的参数：

```ts
// 单代理
{ agent: "worker", task: "重构认证" }

// 并行
{ tasks: [{ agent: "scout", task: "a" }, { agent: "reviewer", task: "b" }] }

// 链式
{ chain: [
  { agent: "scout", task: "收集上下文" },
  { agent: "planner" },
  { agent: "worker" },
  { agent: "reviewer" }
]}

// 后台
{ chain: [...], async: true }

// 工作树隔离（并行 agent 互不干扰）
{ tasks: [
  { agent: "worker", task: "实现 A" },
  { agent: "worker", task: "实现 B" }
], worktree: true }

// 管理操作
{ action: "list" }
{ action: "status" }
{ action: "status", id: "<run-id>" }
{ action: "interrupt", id: "<run-id>" }
{ action: "resume", id: "<run-id>", message: "追问" }
{ action: "doctor" }
```

---

## 文件与日志

| 位置 | 内容 |
|------|------|
| `<tmpdir>/pi-subagents-<scope>/chain-runs/{runId}/` | chain 运行产物 |
| `{sessionDir}/subagent-artifacts/` | 调试产物（输入、输出、元数据） |
| `<tmpdir>/pi-subagents-<scope>/async-subagent-runs/<id>/` | 后台运行状态和日志 |

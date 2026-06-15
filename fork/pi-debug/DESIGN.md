# pi-debug 扩展设计文档

## 背景与问题

在使用 AI 辅助开发时，最常见的痛点之一是：**AI 能写代码，但不会主动编译和测试**。

典型的循环是：

```
用户: 帮我做一个播放器
AI:   写好了代码
用户: 手动编译 → 发现报错 → 把错误信息发给 AI
AI:   修复 → 用户再编译 → 又有新错 → 再喂给 AI
...反复
```

问题不是 AI 没有能力（bash、read、write 工具都有），而是 **AI 缺少"主动调试"的意识**。它不会自己去跑 `npm run build`，不会自己启动 dev server，不会用 Playwright 模拟点击。

**pi-debug 的目标：通过一个技能/扩展，激活 AI 的测试意识，让它进入自主调试循环。**

---

## 核心理念

```
问题不是: AI 能不能编译/测试/跑脚本
问题是:   AI 不会主动去做这些事，需要用户手动喂错误信息
解决:     一个技能（skill），给 AI 一个"调试循环"的工作流
```

---

## 使用场景

### 主力场景
- **Web 前端项目**（React/Vue/Svelte + Vite/Webpack）
- **CLI 工具**（Node.js 命令行工具）
- **混合项目**（Electron 桌面应用等）

### 典型工作流

```
用户: /debug
AI:   检测到这是一个 Electron + Vue 项目
      我来自动诊断一下...
      
      > npm run build
      编译成功
      
      > npm run dev &
      服务启动成功
      
      > curl http://localhost:5173
      页面正常加载
      
      项目状态正常。你遇到了什么问题？

用户: 进度条拖动没反应

AI:   让我看看相关代码...
      找到问题：seek 事件没有绑定到 audio element
      我来修复...
      
      > npm run build    ← 自动重新编译
      ✅ 编译通过
      
      > npm test         ← 自动跑测试
      ✅ 12/12 通过
      
      > npm run dev &    ← 自动启动验证
      > curl ...
      ✅ 组件正常渲染
      
      修复完成。编译通过，测试通过。
```

---

## 实现路径

### 路径 A：纯 Skill（轻量版，推荐先做）

**一个 SKILL.md 文件**，教 AI 如何系统性地调试。

#### 目录结构

```
pi-debug/
  skills/
    debug-workflow/
      SKILL.md          ← 核心：调试工作流指南
  DESIGN.md             ← 本文档
  README.md             ← 使用说明
```

#### SKILL.md 核心内容（草案）

```markdown
---
name: debug-workflow
description: "自主调试工作流。用于修复 bug 时，AI 自动编译、测试、验证，不需要用户手动喂错误信息。触发于：调试、debug、修 bug、修复问题、测试一下。"
---

# 自主调试工作流

当用户报告 bug 或要求调试时，按以下流程操作：

## 第一步：项目分析

1. 检查项目类型（package.json、Cargo.toml、go.mod 等）
2. 找到编译/构建命令（build script）
3. 找到测试命令（test script）
4. 找到启动命令（dev/start script）
5. 确认项目能正常编译和启动

## 第二步：问题确认

1. 让用户描述问题
2. 阅读相关代码，定位可能的原因
3. 向用户确认："我理解的问题是 XXX，对吗？"
4. 确认后开始修复

## 第三步：修复与验证循环

```
while (还有未修复的 bug) {
  1. 修复代码
  2. 编译 → 确认无编译错误
  3. 启动服务（如果需要）
  4. 运行测试脚本
  5. 分析结果
  6. 如果需要用户确认 → 询问用户
  7. 如果还有新问题 → 加入 bug 列表
}
```

## 第四步：测试脚本生成

对于需要交互的测试（UI 点击、按钮操作等），AI 应该：

1. 创建临时测试脚本（放在 /tmp 或项目 .debug/ 目录）
2. 使用合适的工具：
   - Web 前端：Playwright / Puppeteer
   - CLI：直接 spawn 子进程检查输出
   - API：curl / axios
3. 执行脚本，收集结果
4. 清理临时文件

## 关键原则

- **不要等用户喂错误信息** — 自己去编译、启动、测试
- **每一步都要验证** — 修完代码必须重新编译
- **测试脚本可以自动生成** — 不确定怎么测就写脚本
- **临时目录存放测试脚本** — 不要污染项目代码
- **编译失败是最高优先级** — 先修编译错误，再修逻辑错误
```

#### 优点
- 实现成本极低（一个 SKILL.md）
- 立刻能用，放到 `~/.pi/agent/skills/` 即可
- 不需要写 TypeScript
- 可以快速验证想法

#### 缺点
- 没有交互式 UI
- 没有自动循环（需要用户手动触发每次迭代）
- 没有进度追踪

---

### 路径 B：Extension + Skill（完整版，类似 ralph）

**TypeScript 扩展 + 多个 Skill 协作**，提供交互式 UI 和自主循环。

#### 目录结构

```
pi-debug/
  index.ts                    ← 扩展入口，注册 /debug 命令
  package.json                ← 包清单
  skills/
    debug-intake/
      SKILL.md                ← 收集 bug 信息（引导式问答）
    debug-test-plan/
      SKILL.md                ← 生成测试方案
    debug-worker/
      SKILL.md                ← 自主修复+测试循环（worker 指令）
    debug-verify/
      SKILL.md                ← 验证修复结果
  DESIGN.md
  README.md
```

#### 交互流程

```
> /debug

┌─ Debug Mode ─────────────────────────────┐
│ Project: music player (Electron + Vue)    │
│ Status: idle                              │
└───────────────────────────────────────────┘

? 请选择操作
  → Report a bug          报告一个新的 bug
    Run diagnostics       自动诊断项目状态
    Fix all known bugs    修复所有已知 bug
    View test results     查看测试结果
    History               查看历史修复记录
    Exit                  退出调试模式

> Report a bug

? 请描述你遇到的问题
> 进度条拖动之后没有反应

? 请提供错误信息（如果有）
> （粘贴 console 错误，或留空让 AI 自己找）

AI: 我分析了一下代码，发现以下问题：
    1. Player.vue 第 42 行：seek 事件没有绑定到 audio element
    2. 可能缺少事件冒泡处理
    
    你确认这是你要修的问题吗？

? 
  → 确认，开始修复
    需要补充更多信息
    取消

> 确认，开始修复

AI: 好的，让我制定测试方案：
    1. 编译项目 → 验证无编译错误
    2. 启动 dev server → 验证页面加载
    3. 用 Playwright 脚本模拟拖动进度条
    4. 检查 audio.currentTime 是否更新
    
    你确认这个方案吗？

? 
  → 确认方案，开始执行
    需要调整方案
    取消

> 确认方案，开始执行

┌─ Debug Loop ─────────────────────────────┐
│ Iteration 1/10                            │
│ Task: 修复进度条 seek 事件                 │
│ Progress: [####------] 40%                │
└───────────────────────────────────────────┘

[编译] > npm run build
✅ 编译通过 (2.3s)

[修复] 修改 Player.vue 第 42 行
✅ 代码已修改

[重编译] > npm run build
✅ 编译通过 (2.1s)

[测试] 生成 Playwright 脚本...
> node /tmp/debug-test-seek.js
✅ 进度条拖动正常，audio.currentTime 已更新

[结果] 修复完成
  - 编译: ✅
  - 测试: ✅
  - UI: ✅

? 还有其他 bug 要修吗？
  → 继续下一个 bug
    结束调试

> 继续下一个 bug

（循环继续...）
```

#### Worker 执行模式

和 ralph 类似，通过 `spawn` 子 pi 进程执行：

```typescript
async function runDebugWorker(cwd, taskPrompt, skillPath, signal) {
  const args = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--append-system-prompt", skillPath,
    `Task: ${taskPrompt}`,
  ];

  const proc = spawn("pi", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

  // 监听 stdout 事件流
  // 检查编译结果、测试结果
  // 如果需要用户确认 → 暂停循环，询问用户
}
```

#### 与 ralph 的关键区别

| 特性 | ralph | pi-debug |
|------|-------|----------|
| Worker 自主性 | 完全自主，不问用户 | 可能需要中途确认 |
| 循环终止条件 | 所有 story 完成 | 所有 bug 修复 + 测试通过 |
| 用户交互 | 只在开始和结束 | 可能在中间暂停 |
| 测试验证 | 无（由 story 定义） | AI 自己生成测试脚本 |
| 临时文件 | 无 | 创建 .debug/ 目录存放测试脚本 |

#### 优点
- 交互式 UI，体验好
- 自主循环，用户只需确认
- 进度可视化
- 历史记录

#### 缺点
- 实现复杂，需要写 TypeScript
- 需要处理中断/恢复逻辑
- 测试脚本管理有复杂度

---

## 推荐路径

**先做路径 A（纯 Skill），验证想法后再升级为路径 B。**

理由：
1. 核心价值在于**教 AI 主动测试**，一个好 skill 就够了
2. 实现成本低，一天内可以完成
3. 可以立刻在音乐播放器项目上验证
4. 如果 skill 效果好，再投入时间做完整扩展

---

## 待确认的问题

### 1. 测试工具选型

| 场景 | 推荐工具 | 备注 |
|------|---------|------|
| Web 前端 | Playwright | 能模拟点击、拖动、输入 |
| CLI 工具 | spawn + assert | 直接跑命令检查输出 |
| Node.js API | curl / axios | 检查接口响应 |
| Electron | Playwright + electron | 需要特殊配置 |
| 原生 App | 静态分析 + 编译检查 | 无法自动化 UI 测试 |

### 2. 临时测试脚本管理

方案 A：放在 `/tmp/pi-debug-<project>/`
- 优点：不污染项目
- 缺点：重启后丢失

方案 B：放在项目 `.debug/` 目录
- 优点：持久化，可以复用
- 缺点：需要加到 .gitignore

方案 C：放在 `~/.pi/agent/debug-scripts/`
- 优点：全局可用
- 缺点：项目隔离性差

**建议**：方案 B（项目 `.debug/` 目录），同时更新 .gitignore。

### 3. 循环终止条件

- 所有用户报告的 bug 都已修复
- 所有测试脚本都通过
- 编译无错误
- 用户手动确认停止

### 4. 错误处理

- 编译失败：自动重试 3 次，仍然失败则暂停询问用户
- 测试脚本失败：分析失败原因，尝试修复，重新测试
- 用户取消：保存当前进度，可以稍后继续

---

## 参考

- pi-ralph 扩展：`fork/pi-ralph/index.ts` — 自主循环的参考实现
- pi 扩展指南：`fork/pi-extension-guide.md` — 扩展 API 文档
- Skills 系统：`packages/coding-agent/src/core/skills.ts` — Skill 加载机制

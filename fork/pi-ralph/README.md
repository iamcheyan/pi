# pi-ralph

An autonomous AI agent loop plugin for [pi](https://github.com/earendil-works/pi), the AI coding agent.

**Forked from [snarktank/ralph](https://github.com/snarktank/ralph)** — adapted to work as a pi extension plugin with modified logic and pi-native integration.

---

## What is Ralph?

Ralph is an autonomous coding loop: you give it a PRD (Product Requirements Document), and it implements each user story one by one, running quality checks and committing after each iteration — without human intervention.

**pi-ralph** wraps this concept into pi's extension system, providing:

- A single `/ralph` command for status, setup, resume, and loop control
- Automatic skill installation on first load
- Runtime version display in `/ralph` so different machines are easy to compare
- pi-native UI (notifications, confirmations, input prompts)
- A standalone `ralph.sh` script for use outside pi

---

## How It Works

### 1. Entry Flow

```text
/ralph
```

`/ralph` is now the only supported command entrypoint. It does not accept arguments.

When you run it, Ralph opens a small control menu:

- `Continue current task` appears when the current `prd.json` still has unfinished stories
- `Continue PRD draft` appears when a draft PRD exists and is waiting for your manual review
- `Start new task` begins a new intake flow and stages a PRD draft instead of starting execution immediately
- `View history` lists archived runs from `archive/history.json`
- `Exit` leaves the workflow without changing anything

The home screen also shows:

- Plugin version
- Current task summary, branch, and next story
- Active PRD draft path if a draft is waiting for review
- Archived run count for the current project

### 2. Setup (PRD → prd.json)

Ralph asks for a feature description in an input dialog instead of reading command arguments.

The new-task flow now has two phases:

1. **Intake and clarification**
2. **PRD confirmation and execution setup**

During intake, Ralph does this:

1. Accept the feature description
2. Output Ralph's current understanding
3. Ask only the minimum clarifying questions if needed
4. Generate a PRD markdown draft
5. Stop and tell you where the draft file is

At that point Ralph does **not** create `prd.json` yet and does **not** start the loop.

You review and edit the draft markdown yourself. Then you run `/ralph` again and choose `Continue PRD draft`.

### 3. Current Task Resume

When you choose `Continue current task`, Ralph shows a short summary before doing any work:

- Task title and branch
- Story completion count
- Which story will run next
- Why that story is next (the next story with `passes: false`)

If you confirm, Ralph asks for max iterations and starts the loop.

### 4. PRD Draft Review

When a draft is waiting for review, the home menu shows `Continue PRD draft`.

That flow does this:

1. Shows the saved understanding, clarifications, and draft file path
2. Asks whether you have reviewed and edited the draft markdown
3. Converts the confirmed draft into `prd.json`
4. Shows the generated story summary
5. Asks for final confirmation
6. Prompts for max iterations
7. Starts the autonomous loop

If you are not ready yet, Ralph stops and leaves the draft in place. You can edit the file and come back later.

### 5. History and Restore

Every time you replace the current task with a new one, or restore an archived run, Ralph snapshots the old task into `archive/` and records metadata in `archive/history.json`.

The history menu lets you:

- View a summary of an archived task
- View the tail of the archived `progress.txt`
- Compare the archived task with the current task
- Restore an archived task as the current `prd.json` / `progress.txt`

Restoring never silently overwrites the current task. Ralph asks whether the current task should be archived first.

### 6. Autonomous Loop

Each iteration:

1. Ralph reads `prd.json` to find the **next uncompleted story** (lowest priority number first)
2. A worker implements that single story — writing code, running quality checks (`npm run check`), and committing
3. The worker updates `prd.json` (sets `passes: true`) and appends to `progress.txt`
4. Ralph checks if all stories are done; if not, waits 2 seconds and starts the next iteration

The loop runs up to a configurable number of iterations (default: 10).

### 7. Completion

When all stories have `passes: true`, the worker outputs a `<promise>COMPLETE</promise>` signal and the loop stops.

---

## 中文使用流程

下面这部分按你在终端里真实会看到的顺序来写。

### 1. 进入方式

先输入：

```text
/ralph
```

`/ralph` 现在不支持任何参数，只能先进入主菜单，再通过交互选择下一步动作。

### 2. 进入后会先看到什么

Ralph 会先显示一段首页摘要，大概包含这些信息：

- 当前插件版本号
- 当前项目是否有一个 Ralph 任务
- 当前任务所在分支
- 当前任务完成度
- 下一个 story 是什么
- 当前是否有一个等待确认的 PRD 草稿
- 当前项目里有多少条历史归档

然后会弹出一个菜单。

### 3. 主菜单每个选项是什么意思

主菜单可能会看到这些选项：

- `Continue current task`
- `Continue PRD draft`
- `Start new task`
- `View history`
- `Exit`

它们分别表示：

- `Continue current task`：继续当前任务，只在当前 `prd.json` 里还有未完成 story 时出现
- `Continue PRD draft`：继续一个已经生成、但还在等待你手工确认的 PRD 草稿
- `Start new task`：开始一个新任务；如果当前已经有任务，Ralph 会先问你要不要把当前任务归档，然后只生成 PRD 草稿
- `View history`：查看当前项目以前归档过的 Ralph 任务
- `Exit`：退出这次 `/ralph`

如果当前任务已经全部完成，那么不会出现 `Continue current task`。

### 4. `Feature Description` 这一步到底要做什么

当你选择 `Start new task` 后，会出现：

```text
Feature Description
```

这一栏的作用是：

- 用一句到几句话描述你想让 Ralph 规划并实现的功能
- Ralph 会先基于这段描述输出“它的理解”
- 如果信息不够，Ralph 会继续问少量澄清问题
- 然后 Ralph 只生成 PRD Markdown 草稿
- 后续 `prd.json` 和 user stories 会在你确认草稿之后才生成

所以这里不是让你输入命令，也不是让你输入 story 编号，而是输入“你要做什么功能”。

你可以这样理解：

- 这里填的是“任务目标”
- 不是“执行参数”
- 不是“分支名”
- 不是“最大轮数”

### 5. `Feature Description` 应该怎么写

推荐写法：

- 说明你要加什么功能
- 说明影响哪些页面、模块或行为
- 如果有明显边界，也可以顺手写上

例如：

```text
给 MultiChat 增加历史会话列表，用户可以查看最近 20 条历史会话，并且支持点击后恢复到聊天界面。
```

再例如：

```text
给插件增加设置页，允许用户配置默认打开的平台，并把配置持久化到浏览器 storage。
```

不推荐这样写：

```text
修一下
```

或者：

```text
继续做上一个
```

因为这种描述太短，Ralph 很难稳定拆成可执行的 stories。

### 6. 选择 `Start new task` 后的完整步骤

完整流程是这样的：

1. 你在主菜单选 `Start new task`
2. 如果当前已经有一个任务，Ralph 先问你要不要归档当前任务
3. Ralph 弹出 `Feature Description` 输入框
4. 你输入功能描述并提交
5. Ralph 输出它对需求的理解
6. 如果有必要，Ralph 会继续问少量澄清问题
7. Ralph 生成一个 PRD Markdown 草稿
8. Ralph 告诉你草稿文件路径
9. 这一次 `/ralph` 到这里先结束，不会直接开始执行
10. 你自己去打开这个草稿文件并修改确认
11. 修改完成后，再次运行 `/ralph`
12. 在主菜单里选择 `Continue PRD draft`
13. Ralph 把已确认的草稿转换成 `prd.json`
14. Ralph 展示拆出来的 stories 摘要
15. 你确认是否接受这个任务拆分结果
16. Ralph 再问你 `Max Iterations`
17. 你输入最大轮数，或者直接回车使用默认值 `10`
18. 如果当前分支没有 upstream，Ralph 会问你要不要先推到远端
19. 然后 Ralph 才正式开始跑自动循环

### 7. 选择 `Continue current task` 后的完整步骤

如果当前任务还没做完，流程是：

1. 你在主菜单选 `Continue current task`
2. Ralph 显示当前任务摘要
3. Ralph 明确告诉你下一个要跑哪个 story
4. Ralph 说明为什么是这个 story
5. Ralph 问你是否继续
6. 你确认后，再输入 `Max Iterations`
7. 然后开始自动循环

这里的关键点是：

- Ralph 不是记“上次跑到第几步”
- Ralph 是重新读取 `prd.json`
- 找到第一个 `passes: false` 的 story
- 然后从那个 story 继续

所以如果某个 story 没被标记为完成，下次继续时还是会从它开始。

### 8. 选择 `Continue PRD draft` 后的完整步骤

当一个 PRD 草稿已经生成，但你还没确认时，流程是：

1. 你再次运行 `/ralph`
2. 在主菜单里选择 `Continue PRD draft`
3. Ralph 显示之前保存的需求理解、澄清答案和草稿路径
4. Ralph 问你是否已经检查并修改好了这个草稿
5. 如果你确认，Ralph 才把这个草稿转换成 `prd.json`
6. 然后展示 stories 摘要
7. 你确认之后，再设置 `Max Iterations`
8. 最后才开始自动执行

如果你还没改好草稿，Ralph 会停下来，等你下次再继续。

### 9. 选择 `View history` 后的完整步骤

如果项目里已经有归档记录，流程是：

1. 你在主菜单选 `View history`
2. Ralph 列出当前项目里所有历史任务
3. 你选中某一条历史任务
4. Ralph 再给你一个二级菜单

二级菜单里目前支持：

- `View summary`
- `View progress log`
- `Compare with current task`
- `Restore as current task`
- `Back`

它们分别表示：

- `View summary`：看这条历史任务的摘要
- `View progress log`：看这条历史任务归档时的 `progress.txt` 尾部内容
- `Compare with current task`：和当前任务做一个轻量摘要对比
- `Restore as current task`：把这条历史任务恢复成当前项目正在使用的 `prd.json` / `progress.txt`
- `Back`：返回上一级

### 10. `Restore as current task` 会做什么

当你选择恢复历史任务时：

1. 如果当前已经有任务，Ralph 会先问你要不要把当前任务归档
2. 只有你确认后，才会覆盖当前项目里的 `prd.json`
3. 如果历史任务里带有 `progress.txt`，也会一起恢复
4. 恢复完成后，Ralph 会再问你要不要立刻继续跑这个恢复出来的任务

也就是说，恢复不会静默覆盖当前任务。

### 11. 运行中你应该怎么看界面

正式开始执行后，运行中界面主要表达的是：

- 当前是第几轮
- 当前 story 是什么
- 本轮已经跑了多久
- 总共已经跑了多久
- 最近一个 worker step 是什么

如果你看到类似这些内容，说明 Ralph 还在正常执行：

- `Iteration 2/10`
- `round 01:24 | total 08:31`
- `step 12 | tool finished and returned a result`
- `Input is disabled while Ralph is running`

这时输入框不是让你继续输入任务的，而是处于执行中禁用状态。

### 12. 你在 `aigumi` 里现在看到这个输入框时，代表什么

你刚才看到的：

```text
Feature Description
```

说明你当前已经走到了：

- `/ralph`
- 主菜单
- `Start new task`

也就是说，Ralph 现在是在等你输入“新任务的功能描述”。

如果你输入完之后，Ralph 的正确行为应该是：

- 先给出它的理解
- 必要时继续追问
- 生成 PRD 草稿
- 告诉你草稿文件路径
- 停下来等你自己修改确认

它不应该在这一轮里直接开始执行实现任务。

---

## Commands

| Command | Description |
|---------|-------------|
| `/ralph` | The only entrypoint. Shows the Ralph home screen, lets you continue the current task, stage or continue a PRD draft, start a new task, or view and restore archived tasks. |
| `/skill:prd <description>` | Interactive PRD generator (asks clarifying questions, saves to `tasks/prd-*.md`). |

---

## Skills

pi-ralph ships with 6 skills that are automatically symlinked to `~/.pi/agent/skills/` on first load:

| Skill | Purpose |
|-------|---------|
| `prd` | Interactive PRD generator with clarifying questions. Available as `/skill:prd`. |
| `ralph-intake` | Non-interactive intake worker. Summarizes the requested feature and returns only the minimum clarifying questions as JSON. |
| `ralph-prd-draft` | Non-interactive draft worker. Generates only the PRD markdown draft and returns the draft path as JSON. |
| `ralph-wizard` | Legacy non-interactive PRD generator from a feature description. Creates both the PRD markdown and `prd.json`. |
| `ralph` | Non-interactive PRD-to-prd.json converter. Used by the setup wizard. |
| `ralph-worker` | Implements one user story per iteration. Runs quality checks, commits, and updates state files. |

---

## Files Created

After running, Ralph creates these files in your project root:

| File | Purpose |
|------|---------|
| `prd.json` | Structured task list with user stories, priorities, and pass/fail status. |
| `progress.txt` | Append-only log of what was implemented in each iteration. |
| `tasks/prd-*.md` | The original PRD markdown (if generated by `/prd` or `/ralph-wizard`). |
| `.ralph-draft.json` | Active draft state used by `/ralph` to resume PRD review and later convert the draft into `prd.json`. |
| `archive/` | Archived Ralph task snapshots. Each archive contains a `prd.json` and optional `progress.txt`. |
| `archive/history.json` | History index used by `/ralph` to list, compare, and restore archived tasks. |

---

## Standalone Usage (ralph.sh)

For use outside of pi, a shell script is included:

```bash
# With pi (default)
./ralph.sh [max_iterations]

# With other tools
./ralph.sh --tool claude [max_iterations]
./ralph.sh --tool amp [max_iterations]
```

---

## Installation

### As a pi plugin

```bash
pi install @tetsuya/pi-ralph
```

### From source

```bash
git clone https://github.com/tetsuya/pi-ralph.git
cd pi-ralph
pnpm install
pi install .
```

---

## Story Sizing Guidelines

User stories should be small enough to implement in one context window. Examples:

- **Right-sized:** Add a database column and migration; add a UI component to an existing page
- **Too big:** "Build the entire dashboard" → split into schema, queries, UI, filters

**Rule of thumb:** If you can't describe the change in 2-3 sentences, it's too big.

---

## Differences from [snarktank/ralph](https://github.com/snarktank/ralph)

This fork makes the following changes to adapt Ralph for pi:

1. **Extension plugin format** — Ralph is now a pi extension plugin (`ExtensionAPI`) instead of a standalone CLI tool
2. **pi-native UI** — Uses `ctx.ui.notify`, `ctx.ui.confirm`, and `ctx.ui.input` for interactive prompts and progress display
3. **Single interactive entrypoint** — Setup, PRD draft review, resume, status review, history, and restore all flow through `/ralph` prompts
4. **Self-installing skills** — Skills are automatically symlinked to `~/.pi/agent/skills/` on plugin load
5. **JSON stream parsing** — Worker results are parsed from pi's JSON output stream (`--mode json`)
6. **`disable-model-invocation: true`** on worker skills — ensures non-interactive execution without spawning a model
7. **Architecture dependency ordering** — PRD conversion enforces schema → backend → UI → dashboard story order

---

## License

MIT

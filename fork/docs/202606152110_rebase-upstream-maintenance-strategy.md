# [202606152110]_Pi Fork Rebase 上游维护策略

> **创建时间**: 2026-06-15 21:10

## Why

Pi fork 的主要功能已经位于 `fork/**`，真正修改上游核心源码的内容只有两个很小的接入点。旧仓库却长期通过 merge、删除上游外围文件、恢复模板、自动提交和自动 push 来更新，产生了大量 `Update fork files`、`Auto-commit` 和 merge 提交。

这种历史让“真正的 fork 修改”与“某次上游同步带来的代码”混在一起，也让冲突处理脚本拥有过大的删除权限。

因此仓库从最新 `upstream/main` 重新建立干净历史，将自有内容整理为少量线性补丁，并改用 rebase 跟随上游。

## Decision

维护关系如下：

```text
upstream/main
    |
    +-- feat(fork): extensions and tooling
    +-- feat(coding-agent): two upstream seams
    +-- docs(fork): branding and maintenance workflow
```

每次上游更新后，把这些补丁重新应用到新的 `upstream/main`：

```bash
git fetch upstream
git rebase upstream/main
```

正式入口为：

```bash
bash fork/update.sh
```

## What Changed

### 1. 恢复完整上游树

不再删除上游的以下内容：

- `.github/**`
- `.pi/**`
- `docs/**`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `pi-test.*`
- 上游根 `AGENTS.md`

这些文件属于上游项目的一部分。即使 fork 暂时不用，也不应在每次同步时制造大批删除补丁。

### 2. Fork-Owned 目录

主要自有实现继续位于：

```text
fork/**
```

其中包括安装、构建、扩展、Telegram bridge、Ralph、debug 和 minimal UI 相关内容。

### 3. 上游 Seam

只允许修改两个上游源码文件：

| 文件 | 修改 |
|------|------|
| `packages/coding-agent/src/modes/interactive/components/user-message.ts` | minimal UI 用户消息垂直间距 |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 已安装 debug 扩展时让扩展接管 `/debug` |

允许列表：

```text
fork/upstream-seams.allowlist
```

检查命令：

```bash
bash fork/check-upstream-seams.sh
```

每个 seam 都必须带有 `FORK-SEAM(pi)` 标记。

### 4. Submodule 修复

旧历史把 `fork/pi-minimal`、`fork/pi-opencode-config-reader` 保存为 gitlink，却没有 `.gitmodules`，新 clone 无法正确初始化。

现在已增加正式 `.gitmodules`：

```bash
git submodule update --init --recursive
```

失效且没有映射的 `fork/ralph` gitlink 被移除。仓库内实际使用的是 `fork/pi-ralph/**`。

### 5. 更新脚本

新的 `fork/update.sh`：

1. 要求工作区干净。
2. fetch `origin` 与 `upstream`。
3. 确认远端分支没有本地缺失的提交。
4. 创建本地 `backup/pre-upstream-rebase-*` 分支。
5. rebase 到 `upstream/main`。
6. 冲突时停止并给出 continue/abort 命令。
7. 运行 seam 检查、shell 语法检查和 `npm run check`。
8. 使用带明确旧 SHA 的 `--force-with-lease` 推送。

可只在本地更新和审查：

```bash
bash fork/update.sh --no-push
```

仅在明确知道原因时跳过完整检查：

```bash
bash fork/update.sh --skip-check
```

## Daily Development

日常开发仍然在 `main` 完成，不需要为每个功能建立永久分支，也不需要把所有代码塞进 `fork/`。

原则是：

- 独立扩展和 fork 功能优先放在 `fork/**`。
- 必须改变上游行为时，尽量保持修改小，并登记 seam。
- 每个功能使用清楚、独立的 commit。
- 不要把上游同步结果和新功能混在同一个 commit。

上游更新发生冲突时：

```bash
git status
# 编辑冲突文件
git add <resolved-files>
git rebase --continue
```

放弃本次更新：

```bash
git rebase --abort
```

## Benefits

1. 上游代码保持完整，不再用删除列表模拟 fork。
2. 自有补丁数量小，能够直接查看和审查。
3. 每次更新后的历史保持线性。
4. 冲突会准确落到对应的 fork commit。
5. `force-with-lease` 防止覆盖别人刚推送的远端提交。
6. seam 检查可以发现意外修改上游源码的情况。
7. 备份分支保留旧历史，迁移和后续更新都可以恢复。

## Tradeoffs

- rebase 会重写 fork commit SHA，因此不能使用普通 push。
- 多人共同维护同一分支时，需要在更新前协调，避免其他人基于旧 SHA 开发。
- 上游修改两个 seam 附近代码时，仍需人工解决冲突。
- 目录隔离只能减少文本冲突，不能消除上游 API 行为变化。

## Lessons Learned

1. 修改数量小并不等于历史天然干净，自动 merge 和自动提交仍会积累维护成本。
2. 不应为了减少视觉噪音而删除整个上游 `.github`、docs 或配置目录。
3. 自动冲突处理只能针对明确文件和明确规则，不能把未知冲突统一当成删除。
4. gitlink 必须配套 `.gitmodules`，否则仓库不能被可靠复现。
5. 生成文件的纯格式变化不应进入 fork 补丁队列。
6. rebase 适合当前 Pi fork，是因为主要功能已经隔离，核心修改只有两个小 seam。

## Recovery

迁移前历史保存在：

```text
origin/backup/main-before-rebase-20260615
```

同步前未提交内容保存在：

```text
origin/backup/stash-before-rebase-20260615
```

在确认新历史长期稳定之前，不应删除这两个备份分支。

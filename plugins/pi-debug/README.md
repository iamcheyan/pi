# pi-debug

AI 自主调试扩展 —— 让 AI 自己编译、测试、修 bug，不需要你手动喂错误信息。

## 问题

使用 AI 辅助开发时，最常见的痛点：

```
用户: 帮我做一个播放器
AI:   写好了代码
用户: 手动编译 → 发现报错 → 把错误信息发给 AI
AI:   修复 → 用户再编译 → 又有新错 → 再喂给 AI
...反复
```

AI 有能力编译和测试（bash 工具），但**没有意识主动去做**。

## 解决方案

通过 `/debug` 进入交互式调试模式。它会先分析项目、自动检测调试 profile，然后引导用户描述问题。

核心流程：

1. `/debug` → 分析项目，显示检测到的 profile 和可用能力
2. AI 问："你遇到了什么问题？"
3. 用户描述 bug
4. AI 整理理解，用户确认或补充
5. AI 自动匹配调试 profile（高置信度直接使用，低置信度让用户确认）
6. 自动采集复现证据（根据 profile 类型：浏览器日志 / ADB 截图+logcat / 进程输出）
7. AI 生成测试方案，用户确认或修改
8. 启动 worker 自动修复、编译、测试、验证
9. 完成后归档到 `.debug/pi-debug/history/`

已内置的 profile：browser extension、web app、CLI、API、Electron、**Android App**、generic。每种 profile 有专门的采集和验证策略。

## 使用

通过扩展参数加载：

```bash
pi --extension fork/pi-debug/index.ts
```

进入 pi 后运行：

```text
/debug
```

`/debug` 不接受参数，所有信息都通过菜单和弹窗逐步输入。

## 状态

- [x] 设计文档完成
- [x] 实现路径 B（完整扩展）
- [x] TUI 菜单
- [x] 问题澄清与确认
- [x] 测试方案确认
- [x] worker 修复循环
- [x] 历史记录
- [ ] 实战验证更多项目

## 文档

- [设计文档](./DESIGN.md) — 完整的技术设计和讨论记录
- [Profile 路线图](./PROFILES.md) — 长期场景化调试模式设计
- [竞品分析](./COMPETITIVE-ANALYSIS.md) — 市场调研和差异化分析

# OpenTUI 迁移方案

## 背景

当前 pi 项目的 TUI 界面基于自研的 `@earendil-works/pi-tui` 包，想要用 OpenTUI（anomalyco/opentui）重新设计一套更满意的 UI。

**用户需求：**
- 类似 lazygit/lazyvim 的三栏布局
- 顶栏：显示模型信息、运行时间
- 中间：对话界面，可上下滚动
- 底部：固定输入框
- vim 风格的 normal/insert 模式切换
- normal 模式下 j/k 翻页，insert 模式下正常聊天

## 当前架构

```
pi-coding-agent（整车）
├── pi-agent-core（发动机 + 变速箱）
│   └── pi-ai（燃料系统）
├── pi-ai
└── pi-tui（仪表盘 + 方向盘）
```

### 各包职责

| 包 | 职责 | 与 UI 的关系 |
|---|------|-------------|
| **pi-ai** | LLM 提供商抽象层，封装 OpenAI/Anthropic/Google/Mistral 等 API | 无关，保留 |
| **pi-tui** | 终端 UI 组件（输入框、高亮、滚动等） | 完全替换 |
| **pi-agent-core** | Agent 核心循环、工具调度、会话管理 | 无关，保留 |
| **pi-coding-agent** | 最终的 CLI 应用，包含 read/bash/edit/write 工具 | UI 部分重写 |

### pi-tui 当前提供的功能

```
pi-tui
├── TUI 核心
│   ├── 差分渲染（Differential Rendering）
│   ├── 焦点管理
│   ├── Overlay 系统（弹窗、下拉）
│   └── 组件生命周期
├── 组件
│   ├── Text - 文本显示
│   ├── Box - 容器布局
│   ├── Editor - 多行编辑器（语法高亮、IME、撤销重做）
│   ├── Input - 单行输入
│   ├── SelectList - 列表选择
│   ├── Markdown - Markdown 渲染
│   ├── Image - 图片显示（Kitty/iTerm2 协议）
│   ├── Loader - 加载动画
│   ├── Spacer - 间距
│   └── TruncatedText - 截断文本
├── 键盘处理
│   ├── Kitty 协议支持
│   ├── Keybindings 管理
│   └── 快捷键冲突检测
├── 终端能力
│   ├── ProcessTerminal
│   ├── 图片协议检测
│   └── 终端宽度计算
└── 工具函数
    ├── fuzzyMatch/fuzzyFilter
    ├── visibleWidth
    ├── truncateToWidth
    └── wrapTextWithAnsi
```

## 布局分析：为什么难改

### 当前布局模型（简单垂直堆叠）

```typescript
// 来自 interactive-mode.ts 的 init() 方法
this.ui.addChild(this.headerContainer);        // 顶部
this.ui.addChild(this.chatContainer);          // 对话
this.ui.addChild(this.pendingMessagesContainer);
this.ui.addChild(this.statusContainer);
this.ui.addChild(this.widgetContainerAbove);
this.ui.addChild(this.editorContainer);        // 编辑器
this.ui.addChild(this.widgetContainerBelow);
this.ui.addChild(this.footer);                 // 底部
```

**问题：所有区域都是"流式"的，没有固定高度。**

```
当前效果：
┌─────────────────────────────────────┐
│ header                              │ ← 随内容变化位置
├─────────────────────────────────────┤
│ chat (所有对话内容堆在一起)           │
│ message1                            │
│ message2                            │
│ message3                            │
│ ... (内容多了会把顶栏顶出去)          │
├─────────────────────────────────────┤
│ editor                              │
├─────────────────────────────────────┤
│ footer                              │ ← 随内容变化位置
└─────────────────────────────────────┘
```

### 用户想要的布局（固定三栏）

```
┌─────────────────────────────────────┐
│ 顶栏 (固定不动)                      │ ← 固定高度
├─────────────────────────────────────┤
│                                     │
│ 对话 (独立滚动区域)                  │ ← 可滚动
│                                     │
├─────────────────────────────────────┤
│ 底部输入框 (固定不动)                │ ← 固定高度
└─────────────────────────────────────┘
```

### 核心问题

**1. 没有滚动容器（Scrollable Container）**

pi-tui 的 `Container` 只是把子组件的 render 结果拼起来：

```typescript
// Container 的 render 方法
render(width: number): string[] {
    const lines: string[] = [];
    for (const child of this.children) {
        const childLines = child.render(width);
        for (const line of childLines) {
            lines.push(line);
        }
    }
    return lines;
}
```

缺少：
- 固定高度（所有子组件会撑开容器）
- 滚动缓冲区（无法只渲染部分内容）
- viewport 概念（无法实现 j/k 翻页）

**2. 没有区域固定机制**

当前的 `addChild` 顺序决定了布局，但所有区域都是"流式"的。对话内容多了，顶栏会被顶出屏幕。

**3. 没有模式切换状态机**

vim 风格的 normal/insert 模式需要：
- 全局状态（当前模式）
- 按键映射切换（insert 模式打字，normal 模式导航）
- 当前的 keybindings 系统是静态的，没有模式概念

### 需要改动的地方

如果要在现有基础上改，需要：

```
1. pi-tui 核心
├── 新增 ScrollableContainer（固定高度 + 滚动）
├── 新增 Viewport（只渲染可见区域）
└── 新增 StateMachine（模式切换）

2. interactive-mode.ts
├── 重写布局（三栏结构）
├── 重写输入处理（模式切换）
└── 重写滚动逻辑

3. 多个组件
├── chatContainer 需要改为滚动容器
├── header 需要固定高度
└── footer 需要固定高度
```

## OpenTUI 简介

- GitHub: anomalyco/opentui
- Stars: 11k+
- 语言: TypeScript
- 定位: 用于构建终端用户界面的库

## 迁移分析

### 可以完全保留的部分（与 UI 无关）

- `packages/ai/` - LLM 调用层
- `packages/agent/` - Agent 循环逻辑
- `packages/coding-agent/src/core/` - 工具实现、会话管理、配置、扩展系统等
- `packages/coding-agent/src/utils/` - 工具函数

### 需要重写的部分（UI 相关）

| 当前 pi-tui 功能 | OpenTUI 对应 | 预估工作量 | 备注 |
|-----------------|-------------|-----------|------|
| `TUI` 类（主循环） | Application | 中等 | 核心入口 |
| `Component` 接口 | Widget | 中等 | 需要适配 |
| `Container` | Box/Column/Row | 简单 | 布局组件 |
| `Text` | Text | 简单 | 基础组件 |
| `Editor` | 需自己实现 | **复杂** | 多行编辑、语法高亮、IME |
| `Input` | TextInput | 简单 | 单行输入 |
| `SelectList` | List | 简单 | 列表选择 |
| `Markdown` | 需自己实现 | **复杂** | Markdown 渲染到终端 |
| `Image` | Image（如果有） | 中等 | 图片协议支持 |
| `Loader` | Spinner/Progress | 简单 | 加载动画 |
| Kitty 协议 | 需自己处理 | **复杂** | 图片显示 |
| Keybindings | Keybinding 系统 | 中等 | 快捷键管理 |
| Overlay 系统 | Popup/Modal | 中等 | 弹窗系统 |
| fuzzyMatch | 可能自带或用库 | 简单 | 模糊搜索 |
| 文本宽度计算 | 需自己处理 | 中等 | CJK 字符支持 |

### 关键挑战

#### 1. 编辑器组件（Editor）- 最大难点

pi-tui 的 Editor 支持：
- 多行编辑
- 语法高亮（通过 themes）
- IME 输入法支持（中文输入）
- 撤销/重做（UndoStack）
- 自动补全（Autocomplete）
- 光标定位（CURSOR_MARKER）
- Kitty 协议的按键处理

OpenTUI 可能没有这么复杂的 Editor，可能需要：
- 寻找现有的 TUI Editor 库
- 或基于 OpenTUI 底层 API 自己实现

#### 2. Markdown 渲染

pi-tui 用 `marked` 解析 Markdown，然后渲染成终端格式。需要：
- 保持代码块高亮
- 支持链接、列表、表格
- 处理 ANSI 颜色

#### 3. 工具输出渲染

coding-agent 的工具返回的内容使用 pi-tui 组件渲染：

```typescript
// 来自 packages/coding-agent/src/core/tools/
import { Text } from "@earendil-works/pi-tui";  // read.ts, find.ts, ls.ts, grep.ts
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";  // edit.ts
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";  // bash.ts
```

这些都需要改成 OpenTUI 的组件。

#### 4. 扩展系统

coding-agent 支持扩展，扩展可以使用 pi-tui 的组件：

```typescript
// 来自 packages/coding-agent/src/core/extensions/
import type { Component, ... } from "@earendil-works/pi-tui";
```

需要考虑扩展系统的兼容性。

### coding-agent 中对 pi-tui 的依赖统计

```
直接使用 pi-tui 的文件：
├── src/core/tools/read.ts - Text
├── src/core/tools/find.ts - Text
├── src/core/tools/ls.ts - Text
├── src/core/tools/grep.ts - Text
├── src/core/tools/edit.ts - Box, Container, Spacer, Text
├── src/core/tools/bash.ts - Container, Text, truncateToWidth
├── src/core/tools/write.ts - Container, Text
├── src/core/tools/render-utils.ts - getCapabilities, getImageDimensions
├── src/core/extensions/loader.ts - KeyId, * as _bundledPiTui
├── src/core/extensions/types.ts - 多个类型
├── src/core/extensions/runner.ts - KeyId
├── src/core/keybindings.ts - 多个类型
├── src/core/export-html/tool-renderer.ts - Component
├── src/main.ts - ProcessTerminal, setKeybindings, TUI
├── src/modes/interactive/interactive-mode.ts - 大量导入
└── src/modes/interactive/components/*.ts - 多个组件文件
```

## 两种方案对比

| 方案 | 工作量 | 风险 | 说明 |
|------|--------|------|------|
| **在 pi-tui 上改** | 大 | 高 | 需要改核心渲染逻辑，可能影响现有功能 |
| **用 OpenTUI 重写** | 大 | 中 | 从零开始，但架构更干净 |

**结论：两个工作量差不多。**

区别在于：
- 改 pi-tui：要理解复杂的差分渲染逻辑，改动可能破坏现有功能
- 用 OpenTUI：从零写，但可以按需求设计，不用背历史包袱

## 迁移策略

### 推荐方案：渐进式迁移

```
阶段一：准备工作
├── 在 coding-agent 中引入 OpenTUI 依赖
├── 新建 src/modes/opentui/ 目录
└── 保留原有 src/modes/interactive/ 不动

阶段二：基础组件迁移
├── 先实现简单组件：Text, Box, Input, SelectList
├── 实现主循环：Application
└── 验证基本流程能跑通

阶段三：复杂组件迁移
├── Input（单行输入）
├── Keybindings 系统
├── Overlay/弹窗系统
└── 列表选择器

阶段四：最难的部分
├── Editor（多行编辑器）
├── Markdown 渲染
├── 图片支持
└── IME 输入法支持

阶段五：清理
├── 删除 pi-tui 依赖
├── 删除 src/modes/interactive/
└── 重命名 opentui 模式为 interactive
```

### 风险点

1. **Editor 组件**可能需要大量工作，考虑是否能用现有库
2. **IME 支持**在 TUI 中是难点，需要测试 OpenTUI 的支持情况
3. **扩展系统兼容性** - 如果扩展依赖 pi-tui 组件，需要提供适配层
4. **性能** - 差分渲染是 pi-tui 的核心优势，需要确认 OpenTUI 的实现

## 待确认问题

1. OpenTUI 是否支持 Kitty 协议和 iTerm2 图片协议？
2. OpenTUI 的 Editor 组件能力如何？是否支持多行编辑？
3. OpenTUI 是否有差分渲染？性能如何？
4. OpenTUI 的 IME 支持情况如何？
5. 是否需要保留 pi-tui 作为 fallback？

## 参考资源

- OpenTUI GitHub: https://github.com/anomalyco/opentui
- OpenTUI 文档: https://opentui.com
- 当前 pi-tui 源码: packages/tui/src/
- coding-agent 交互模式: packages/coding-agent/src/modes/interactive/

# pi-minimal Message Spacing Investigation

## Problem

When `pi` is started with the local minimal extension:

```bash
packages/coding-agent/dist/pi \
  --extension fork/pi-minimal/extensions/index.ts \
  --extension fork/pi-opencode-config-reader/opencode-config-reader.ts
```

messages in the chat area still show visible blank lines around user prompts:

```text

 你好


 The user is speaking Chinese...
```

The desired behavior for `pi-minimal` is a denser REPL-style transcript with no blank line above or below the user message.

## Current Understanding

This should be fixed in the fork extension, not by directly editing upstream files under `packages/coding-agent/src`. Direct edits there are fragile because future upstream syncs can overwrite them.

The relevant upstream rendering paths are:

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
  - `addMessageToChat()` adds a `Spacer(1)` before user messages when chat already has content.
  - assistant messages are added as `AssistantMessageComponent`.
- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`
  - `AssistantMessageComponent.updateContent()` adds a leading `Spacer(1)` when assistant content is visible.
- `packages/coding-agent/src/modes/interactive/components/user-message.ts`
  - `UserMessageComponent` uses `Box(1, 0, ...)`, so the user message component itself has horizontal padding but no vertical padding.

Because the blank lines are created by upstream TUI components, changing themes alone is not enough.

## Role of `packages/tui`

The monorepo has four default core packages under `packages/`:

- `packages/tui`: terminal UI engine and component library.
- `packages/ai`: model/provider abstractions and streaming message APIs.
- `packages/agent`: agent loop and message/tool orchestration.
- `packages/coding-agent`: the `pi` CLI, interactive mode, sessions, extensions, settings, and package integration.

`packages/tui` is the low-level terminal UI layer. It owns:

- rendering component trees into terminal lines;
- differential terminal redraw;
- base components such as `Container`, `Text`, `Markdown`, `Box`, `Spacer`, loaders, editors, selectors, and overlays;
- keyboard input, focus, keybindings, cursor positioning, ANSI styling, terminal width measurement, and terminal capabilities.

The interactive chat UI in `packages/coding-agent` is built on top of `packages/tui`. For example, `UserMessageComponent` and `AssistantMessageComponent` live in `packages/coding-agent`, but they render through `packages/tui` primitives such as `Box`, `Markdown`, `Container`, and `Spacer`.

This is why the spacing issue surfaces at the rendered terminal-line level: upstream `coding-agent` message components add spacing and padding, then `tui` turns those components into final terminal output.

## Replacing `packages/tui`

It is theoretically possible to build a new terminal UI layer and keep using the other packages (`ai`, `agent`, and parts of `coding-agent`). The boundary is not impossible, but it is not a drop-in replacement today.

Practical options:

- Keep `packages/ai` and `packages/agent`, then build a new CLI/TUI shell from scratch. This is the cleanest architecture if the goal is a completely different UI.
- Reuse `packages/coding-agent` core/session logic but replace only interactive rendering. This is possible, but harder, because current interactive mode imports `packages/tui` types and components throughout.
- Replace `packages/tui` with a compatibility implementation that exports the same API. This avoids rewriting `coding-agent` immediately, but it means reimplementing a large surface area: components, editor behavior, input handling, overlays, render diffing, and terminal capability handling.

For `pi-minimal`, the current extension-side approach is intentionally smaller: it leaves upstream `packages/tui` and `packages/coding-agent` intact, then changes only the rendered output behavior needed for the minimal REPL style.

## First Attempt

`fork/pi-minimal/extensions/index.ts` already tried to patch spacing from inside `MinimalEditor`:

```ts
const chatContainer = tui.children[1]
chatContainer.addChild = function (child: any) {
  if (child instanceof Spacer) return
  originalAddChild(child)
}
```

This did not affect the observed spacing reliably.

Likely reasons:

- The editor component is not the right lifecycle point for patching chat rendering.
- `instanceof Spacer` can fail across runtime loader/module boundaries.
- Removing only `Spacer` components from `chatContainer.addChild()` does not cover blank lines emitted inside a child component's own `render()`.

## Current Extension-Side Patch

The patch now lives in `fork/pi-minimal/extensions/index.ts`.

It installs the chat spacing patch during `session_start`, inside the `ctx.ui.setHeader()` factory. That factory receives the live TUI instance after the root layout has been created.

The final successful patch wraps the root TUI `render()` method and compacts the already-rendered output lines.

The key details:

- The upstream `UserMessageComponent` wraps the user text in OSC 133 zone markers and a `Box`, which renders visual padding lines containing ANSI/OSC sequences and spaces.
- These lines are not plain empty strings, so earlier filters that only removed `""` lines or specific `Spacer` components did not fully work.
- The extension now detects visual blank lines by stripping ANSI CSI, OSC, and cursor marker sequences before trimming.
- Any consecutive visual blank-line segment that contains a message start/end marker is removed.
- This removes the blank line above and below user messages without modifying upstream source files.

This keeps the change outside upstream source and makes it part of the local `pi-minimal` behavior.

## User Message Color

The minimal theme now gives user messages their own foreground color:

- `fork/pi-minimal/themes/minimal.json`
  - `vars.blue` is `#80a0f0`
  - `colors.userMessageText` uses `blue`

This keeps assistant replies in the default light text color while making user prompts visually distinct.

The extension also refreshes the bundled theme on startup when the source theme differs from the installed `~/.pi/agent/themes/minimal.json`. Without this, an already-installed old theme could keep the old white user-message color.

## Rebuild Behavior

No rebuild should be required for this extension change.

The command passes `fork/pi-minimal/extensions/index.ts` through `--extension`, so the TypeScript extension file is loaded at runtime when `pi` starts. Restarting `pi` should be enough.

Rebuilding `packages/coding-agent` would only matter for changes under `packages/coding-agent/src` or generated `dist` output, not for this extension file.

## Verification So Far

`npm run check` passes after the extension changes.

A tmux startup check confirmed the extension can still start and render the custom `pi-repl` header.

The successful verification used:

```bash
tmux new-session -d -s pi-minimal-spacing -x 80 -y 24
tmux send-keys -t pi-minimal-spacing "packages/coding-agent/dist/pi --extension fork/pi-minimal/extensions/index.ts --extension fork/pi-opencode-config-reader/opencode-config-reader.ts" Enter
tmux send-keys -t pi-minimal-spacing "hi" Enter
tmux send-keys -t pi-minimal-spacing "again" Enter
tmux capture-pane -t pi-minimal-spacing -p
```

The captured output showed both user messages rendered with no blank line above or below:

```text
hi
The user is greeting me...
...
again
The user just said "again"...
```

## Remaining Risk

The current approach filters root rendered lines instead of changing upstream component internals. That makes it robust against `chatContainer` index changes and avoids direct access to private component fields.

The main remaining risk is that it depends on upstream message components continuing to use OSC 133 markers for message boundaries. If those markers change, the compacting rule should be updated to match the new boundary signal.

If that happens, the next refinement should propose an upstream extension API for customizing message spacing.

/**
 * pi-ralph - Autonomous AI agent loop for pi
 *
 * Based on snarktank/ralph (https://github.com/snarktank/ralph).
 *
 * Single entry point: /ralph
 *
 *   /ralph                          → show status / start loop
 *   /ralph <feature description>    → setup wizard (create PRD + prd.json)
 *   /ralph <N>                      → start loop with max N iterations
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import type { Message } from "@earendil-works/pi-ai"
import { CustomEditor, type ExtensionAPI, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent"

// ============================================================================
// Types
// ============================================================================

interface UserStory {
  id: string
  title: string
  description: string
  acceptanceCriteria: string[]
  priority: number
  passes: boolean
  notes: string
}

interface PrdJson {
  project: string
  branchName: string
  description: string
  userStories: UserStory[]
}

interface WorkerResult {
  exitCode: number
  messages: Message[]
  stderr: string
  completed: boolean
}

type WorkerPhase = "running" | "completed" | "failed"
type WorkerProgress = {
  stepCount: number
  lastEvent: string
}
const RALPH_PLUGIN_VERSION = "20260531-015525"
const WORKER_SPINNER_FRAMES = ["-", "\\", "|", "/"] as const
type BusyEditorState = {
  phase: WorkerPhase
  label: string
  roundElapsed: string
  totalElapsed: string
  progress?: WorkerProgress
}
let busyEditorState: BusyEditorState | undefined
let busyUiTheme: Theme | undefined
let busyEditorMounted = false

class RalphBusyEditor extends CustomEditor {
  private frame = 0
  private animationTimer?: ReturnType<typeof setInterval>

  constructor(...args: ConstructorParameters<typeof CustomEditor>) {
    super(...args)
    this.animationTimer = setInterval(() => {
      this.frame += 1
      this.tui.requestRender()
    }, 120)
  }

  dispose(): void {
    if (this.animationTimer) {
      clearInterval(this.animationTimer)
      this.animationTimer = undefined
    }
  }

  handleInput(data: string): void {
    if (data.length === 1 && data.charCodeAt(0) >= 32) return
    super.handleInput(data)
  }

  render(width: number): string[] {
    const state = busyEditorState
    const spinner = state?.phase === "running"
      ? WORKER_SPINNER_FRAMES[this.frame % WORKER_SPINNER_FRAMES.length]
      : state?.phase === "completed"
        ? "OK"
        : "!!"
    const stepLine = state?.progress
      ? formatProgressLabel(state.progress)
      : "waiting for worker events"
    const statusColor = state?.phase === "failed"
      ? "error"
      : state?.phase === "completed"
        ? "success"
        : "accent"
    const theme = busyUiTheme
    const formatLine = (color: "accent" | "error" | "muted" | "success" | "text" | "warning", text: string): string =>
      theme ? theme.fg(color, text) : text

    return [
      formatLine(statusColor, `Ralph ${spinner} ${state?.phase ?? "running"}`),
      formatLine("accent", `pi-ralph v${RALPH_PLUGIN_VERSION}`),
      formatLine("text", state?.label ?? "Ralph is executing"),
      formatLine("muted", `round ${state?.roundElapsed ?? "00:00"} | total ${state?.totalElapsed ?? "00:00"}`),
      formatLine("muted", stepLine),
      formatLine("warning", "Input is disabled while Ralph is running."),
      formatLine("accent", "Press Ctrl+C to interrupt this iteration."),
    ].map((line) => line.slice(0, width))
  }
}

// #region debug-point A:reporter
function reportDebugEvent(
  hypothesisId: "A" | "B" | "C" | "D" | "E",
  location: string,
  msg: string,
  data: Record<string, unknown> = {},
): void {
  let url = "http://127.0.0.1:7777/event"
  let sessionId = "ralph-worker-stall"
  try {
    const envPath = "/Users/tetsuya/Development/pi/.dbg/ralph-worker-stall.env"
    if (existsSync(envPath)) {
      const env = readFileSync(envPath, "utf-8")
      url = env.match(/DEBUG_SERVER_URL=(.+)/)?.[1] || url
      sessionId = env.match(/DEBUG_SESSION_ID=(.+)/)?.[1] || sessionId
    }
  } catch {}
  void fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId,
      runId: "pre-fix",
      hypothesisId,
      location,
      msg: `[DEBUG] ${msg}`,
      data,
      ts: Date.now(),
    }),
  }).catch(() => {})
}
// #endregion

// ============================================================================
// Self-install: symlink skills to ~/.pi/agent/skills/
// ============================================================================

const SKILLS = ["prd", "ralph", "ralph-worker", "ralph-wizard"] as const

function getExtensionDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

function ensureSkillsInstalled(): void {
  const extensionDir = getExtensionDir()
  const skillsSourceDir = join(extensionDir, "skills")
  const skillsTargetDir = join(homedir(), ".pi", "agent", "skills")

  if (!existsSync(skillsSourceDir)) return

  for (const skill of SKILLS) {
    const src = join(skillsSourceDir, skill, "SKILL.md")
    const destDir = join(skillsTargetDir, skill)
    const dest = join(destDir, "SKILL.md")

    if (!existsSync(src)) continue
    if (existsSync(dest)) continue

    try {
      mkdirSync(destDir, { recursive: true })
      symlinkSync(src, dest)
    } catch {
      // Ignore symlink errors (e.g. already exists race condition)
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function readJsonFile(filePath: string): unknown | null {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"))
  } catch {
    return null
  }
}

function findNextStory(prd: PrdJson): UserStory | null {
  const uncompleted = prd.userStories
    .filter((s) => !s.passes)
    .sort((a, b) => a.priority - b.priority)
  return uncompleted[0] ?? null
}

function allStoriesComplete(prd: PrdJson): boolean {
  return prd.userStories.every((s) => s.passes)
}

function formatTimestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}

// ============================================================================
// Archive
// ============================================================================

function archivePreviousRun(prdPath: string, progressPath: string): void {
  if (!existsSync(prdPath)) return

  const prd = readJsonFile(prdPath) as PrdJson | null
  if (!prd?.branchName) return

  const lastBranchPath = join(dirname(prdPath), ".last-branch")
  const lastBranch = existsSync(lastBranchPath) ? readFileSync(lastBranchPath, "utf-8").trim() : ""

  if (lastBranch && lastBranch !== prd.branchName) {
    const date = new Date().toISOString().slice(0, 10)
    const folderName = lastBranch.replace(/^ralph\//, "")
    const archiveDir = join(dirname(prdPath), "archive", `${date}-${folderName}`)

    mkdirSync(archiveDir, { recursive: true })
    if (existsSync(prdPath)) copyFileSync(prdPath, join(archiveDir, "prd.json"))
    if (existsSync(progressPath)) copyFileSync(progressPath, join(archiveDir, "progress.txt"))

    writeFileSync(
      progressPath,
      `# Ralph Progress Log\nStarted: ${formatTimestamp()}\n---\n`,
      "utf-8",
    )
  }

  writeFileSync(lastBranchPath, prd.branchName, "utf-8")
}

type GitCommandResult = {
  ok: boolean
  stdout: string
  stderr: string
}

function runGitCommand(cwd: string, args: string[]): GitCommandResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
  })

  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  }
}

function getCurrentBranch(cwd: string): string | null {
  const result = runGitCommand(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
  if (!result.ok || !result.stdout || result.stdout === "HEAD") return null
  return result.stdout
}

function getHeadSha(cwd: string): string | null {
  const result = runGitCommand(cwd, ["rev-parse", "HEAD"])
  if (!result.ok || !result.stdout) return null
  return result.stdout
}

function hasUpstreamBranch(cwd: string): boolean {
  return runGitCommand(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).ok
}

function hasRemoteBranch(cwd: string, remote: string, branch: string): boolean {
  return runGitCommand(cwd, ["ls-remote", "--exit-code", "--heads", remote, branch]).ok
}

async function maybeOfferInitialPush(ctx: ExtensionCommandContext, cwd: string): Promise<void> {
  const branch = getCurrentBranch(cwd)
  if (!branch) return
  if (hasUpstreamBranch(cwd)) return
  if (hasRemoteBranch(cwd, "origin", branch)) return

  const shouldPush = await ctx.ui.confirm(
    "Publish Ralph Branch?",
    [
      `Current branch: ${branch}`,
      "No matching branch was found on origin.",
      "",
      "Push this branch to origin now and set upstream?",
    ].join("\n"),
  )

  if (!shouldPush) return

  const pushResult = runGitCommand(cwd, ["push", "-u", "origin", branch])
  if (pushResult.ok) {
    ctx.ui.notify(`Published branch ${branch} to origin and set upstream.`, "info")
    return
  }

  const errorText = pushResult.stderr || pushResult.stdout || "git push failed"
  ctx.ui.notify(`Failed to publish branch ${branch}.\n\n${errorText}`, "warning")
}

function maybeAutoPushLatestCommit(ctx: ExtensionCommandContext, cwd: string, previousHead: string | null): void {
  if (!hasUpstreamBranch(cwd)) return

  const currentHead = getHeadSha(cwd)
  if (!currentHead || currentHead === previousHead) return

  const pushResult = runGitCommand(cwd, ["push"])
  if (pushResult.ok) return

  const branch = getCurrentBranch(cwd) ?? "current branch"
  const errorText = pushResult.stderr || pushResult.stdout || "git push failed"
  ctx.ui.notify(`Auto-push failed for ${branch}.\n\n${errorText}`, "warning")
}

// ============================================================================
// Pi process spawning
// ============================================================================

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1]
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/")
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] }
  }

  const execName = dirname(process.execPath).toLowerCase()
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
  if (!isGenericRuntime) {
    return { command: process.execPath, args }
  }

  return { command: "pi", args }
}

async function runWorker(
  cwd: string,
  taskPrompt: string,
  workerPromptPath: string,
  signal: AbortSignal | undefined,
  onProgress?: (progress: WorkerProgress) => void,
): Promise<WorkerResult> {
  const result: WorkerResult = {
    exitCode: 0,
    messages: [],
    stderr: "",
    completed: false,
  }

  const args = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--append-system-prompt", workerPromptPath,
    `Task: ${taskPrompt}`,
  ]

  // #region debug-point A:run-worker-start
  reportDebugEvent("A", "index.ts:runWorker:start", "runWorker invoked", {
    cwd,
    workerPromptPath,
    taskPromptPreview: taskPrompt.slice(0, 200),
    args,
  })
  // #endregion

  return new Promise((resolve) => {
    const invocation = getPiInvocation(args)
    // #region debug-point A:run-worker-spawn
    reportDebugEvent("A", "index.ts:runWorker:spawn", "spawning child pi process", {
      command: invocation.command,
      args: invocation.args,
      cwd,
    })
    // #endregion
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let buffer = ""
    let stepCount = 0

    const emitProgress = (lastEvent: string) => {
      stepCount += 1
      onProgress?.({ stepCount, lastEvent })
    }

    const processLine = (line: string) => {
      if (!line.trim()) return
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line)
      } catch {
        return
      }

      if (event.type === "message_end" && event.message) {
        const msg = event.message as Message
        result.messages.push(msg)
        // #region debug-point B:message-end
        reportDebugEvent("B", "index.ts:runWorker:message_end", "child message_end received", {
          role: msg.role,
          stopReason: "stopReason" in msg ? msg.stopReason : undefined,
          errorMessage: "errorMessage" in msg ? msg.errorMessage : undefined,
        })
        // #endregion
        emitProgress(`message:${msg.role}`)

        if (msg.role === "assistant") {
          for (const part of msg.content) {
            if (part.type === "text" && part.text.includes("<promise>COMPLETE</promise>")) {
              result.completed = true
            }
          }
        }
      }

      if (event.type === "tool_result_end" && event.message) {
        result.messages.push(event.message as Message)
        // #region debug-point B:tool-result-end
        reportDebugEvent("B", "index.ts:runWorker:tool_result_end", "child tool_result_end received")
        // #endregion
        emitProgress("tool_result")
      }
    }

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() || ""
      for (const line of lines) processLine(line)
    })

    proc.stderr.on("data", (data: Buffer) => {
      result.stderr += data.toString()
      // #region debug-point C:stderr
      reportDebugEvent("C", "index.ts:runWorker:stderr", "child stderr chunk received", {
        chunk: data.toString().slice(0, 400),
      })
      // #endregion
      emitProgress("stderr")
    })

    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer)
      result.exitCode = code ?? 0
      // #region debug-point D:close
      reportDebugEvent("D", "index.ts:runWorker:close", "child process closed", {
        exitCode: result.exitCode,
        completed: result.completed,
        stderrPreview: result.stderr.slice(0, 400),
        messageCount: result.messages.length,
      })
      // #endregion
      resolve(result)
    })

    proc.on("error", () => {
      result.exitCode = 1
      // #region debug-point A:spawn-error
      reportDebugEvent("A", "index.ts:runWorker:error", "child process emitted error")
      // #endregion
      resolve(result)
    })

    if (signal) {
      const killProc = () => {
        // #region debug-point C:abort
        reportDebugEvent("C", "index.ts:runWorker:abort", "abort signal received, terminating child")
        // #endregion
        proc.kill("SIGTERM")
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL")
        }, 5000)
      }
      if (signal.aborted) killProc()
      else signal.addEventListener("abort", killProc, { once: true })
    }
  })
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text
      }
    }
  }
  return ""
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function formatProgressLabel(progress?: WorkerProgress): string {
  if (!progress) return "waiting for worker events"
  const event = progress.lastEvent
  if (event === "message:user") return `step ${progress.stepCount} | task handed to worker`
  if (event === "message:assistant") return `step ${progress.stepCount} | worker planned the next action`
  if (event === "message:toolResult" || event === "tool_result") {
    return `step ${progress.stepCount} | tool finished and returned a result`
  }
  if (event === "stderr") return `step ${progress.stepCount} | worker emitted stderr output`
  return `step ${progress.stepCount} | ${event}`
}

function setWorkerUiStatus(
  ctx: ExtensionCommandContext,
  phase: WorkerPhase,
  label: string,
  roundStartedAt: number,
  totalStartedAt: number,
  progress?: WorkerProgress,
): void {
  const roundElapsed = formatElapsed(Date.now() - roundStartedAt)
  const totalElapsed = formatElapsed(Date.now() - totalStartedAt)
  const progressSuffix = progress ? ` | ${formatProgressLabel(progress)}` : ""
  const text = `Ralph ${phase}: ${label} (round ${roundElapsed} | total ${totalElapsed})${progressSuffix}`
  busyEditorState = { phase, label, roundElapsed, totalElapsed, progress }
  busyUiTheme = ctx.ui.theme
  ctx.ui.setStatus("ralph", text)
  ctx.ui.setWidget("ralph-progress", undefined)

  if (phase === "running") {
    if (!busyEditorMounted) {
      ctx.ui.setEditorText("")
      ctx.ui.setEditorComponent((tui, theme, keybindings) => new RalphBusyEditor(tui, theme, keybindings))
      busyEditorMounted = true
    }
    ctx.ui.setWorkingVisible(true)
    ctx.ui.setWorkingMessage(text)
    ctx.ui.setWorkingIndicator({ frames: [...WORKER_SPINNER_FRAMES], intervalMs: 120 })
  } else {
    ctx.ui.setWorkingVisible(false)
    ctx.ui.setWorkingMessage()
    if (busyEditorMounted) {
      ctx.ui.setEditorComponent(undefined)
      busyEditorMounted = false
    }
  }
}

function startWorkerStatus(
  ctx: ExtensionCommandContext,
  label: string,
  totalStartedAt: number,
): {
  update: (progress: WorkerProgress) => void
  finish: (phase: Exclude<WorkerPhase, "running">) => void
} {
  const roundStartedAt = Date.now()
  let latestProgress: WorkerProgress | undefined
  setWorkerUiStatus(ctx, "running", label, roundStartedAt, totalStartedAt, latestProgress)

  const interval = setInterval(() => {
    setWorkerUiStatus(ctx, "running", label, roundStartedAt, totalStartedAt, latestProgress)
  }, 1000)

  return {
    update: (progress) => {
      latestProgress = progress
      setWorkerUiStatus(ctx, "running", label, roundStartedAt, totalStartedAt, latestProgress)
    },
    finish: (phase) => {
      clearInterval(interval)
      setWorkerUiStatus(ctx, phase, label, roundStartedAt, totalStartedAt, latestProgress)
    },
  }
}

// ============================================================================
// Resolve skill path
// ============================================================================

function skillPath(...segments: string[]): string {
  return join(getExtensionDir(), "skills", ...segments)
}

function resolveSkillPath(skillName: typeof SKILLS[number], cwd: string): string | null {
  const candidates = [
    skillPath(skillName, "SKILL.md"),
    join(homedir(), ".pi", "agent", "skills", skillName, "SKILL.md"),
    join(cwd, ".pi", "skills", skillName, "SKILL.md"),
    join(cwd, ".agents", "skills", skillName, "SKILL.md"),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return null
}

function getSkillLookupPaths(skillName: typeof SKILLS[number], cwd: string): string[] {
  return [
    skillPath(skillName, "SKILL.md"),
    join(homedir(), ".pi", "agent", "skills", skillName, "SKILL.md"),
    join(cwd, ".pi", "skills", skillName, "SKILL.md"),
    join(cwd, ".agents", "skills", skillName, "SKILL.md"),
  ]
}

function showStatus(ctx: ExtensionCommandContext, prd: PrdJson): void {
  const done = prd.userStories.filter((s) => s.passes).length
  const total = prd.userStories.length
  const remaining = total - done
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  const barWidth = 20
  const filled = Math.round((pct / 100) * barWidth)
  const bar = "#".repeat(filled) + "-".repeat(barWidth - filled)

  const lines = [
    `Ralph Status (pi-ralph v${RALPH_PLUGIN_VERSION})`,
    "",
    `Project:   ${prd.project}`,
    `Branch:    ${prd.branchName}`,
    `Feature:   ${prd.description}`,
    "",
    `Progress:  ${done}/${total} stories complete`,
    `[${bar}] ${pct}%`,
    "",
  ]

  for (const s of prd.userStories) {
    const icon = s.passes ? "x" : "o"
    lines.push(`  ${icon} ${s.id}  ${s.title}`)
  }

  if (remaining > 0) {
    lines.push("")
    lines.push(`Run /ralph to continue (${remaining} stories remaining).`)
  } else {
    lines.push("")
    lines.push("All stories complete.")
  }

  ctx.ui.notify(lines.join("\n"), "info")
}

// ============================================================================
// Display helpers
// ============================================================================

function formatStatus(prd: PrdJson): string {
  const done = prd.userStories.filter((s) => s.passes).length
  const total = prd.userStories.length
  const remaining = total - done

  const lines = [
    `Plugin:    pi-ralph v${RALPH_PLUGIN_VERSION}`,
    `Project:   ${prd.project}`,
    `Branch:    ${prd.branchName}`,
    `Feature:   ${prd.description}`,
    `Progress:  ${done}/${total} stories complete`,
    "",
  ]

  if (remaining > 0) {
    lines.push("Remaining stories:")
    for (const s of prd.userStories.filter((s) => !s.passes)) {
      lines.push(`  ${s.id} [P${s.priority}] ${s.title}`)
    }
  }

  return lines.join("\n")
}

// ============================================================================
// Autonomous loop
// ============================================================================

async function startLoop(
  ctx: ExtensionCommandContext,
  prdPath: string,
  progressPath: string,
  input: string,
): Promise<void> {
  const cwd = ctx.cwd
  const maxIterations = /^\d+$/.test(input) ? parseInt(input, 10) : 10
  const totalStartedAt = Date.now()

  archivePreviousRun(prdPath, progressPath)

  if (!existsSync(progressPath)) {
    writeFileSync(progressPath, `# Ralph Progress Log\nStarted: ${formatTimestamp()}\n---\n`, "utf-8")
  }

  const prd = readJsonFile(prdPath) as PrdJson | null
  if (!prd || !prd.userStories || !Array.isArray(prd.userStories)) {
    ctx.ui.notify("prd.json is invalid or has no userStories.", "error")
    return
  }

  const remaining = prd.userStories.filter((s) => !s.passes).length
  ctx.ui.notify([
    formatStatus(prd),
    "",
    `Starting autonomous loop — max ${maxIterations} iterations, ${remaining} stories remaining`,
  ].join("\n"), "info")

  const workerSkillPath = resolveSkillPath("ralph-worker", cwd)
  if (!workerSkillPath) {
    const lookedIn = getSkillLookupPaths("ralph-worker", cwd).map((p) => `- ${p}`).join("\n")
    ctx.ui.notify(`Could not find ralph-worker skill.\n\nLooked in:\n${lookedIn}`, "error")
    return
  }

  for (let i = 1; i <= maxIterations; i++) {
    const currentPrd = readJsonFile(prdPath) as PrdJson | null
    if (!currentPrd) {
      ctx.ui.notify(`Iteration ${i}: prd.json disappeared, stopping.`, "error")
      return
    }

    const nextStory = findNextStory(currentPrd)
    if (!nextStory || allStoriesComplete(currentPrd)) {
      ctx.ui.notify(`Ralph complete — all ${currentPrd.userStories.length} stories done in ${i - 1} iterations`, "info")
      return
    }

    ctx.ui.notify(`Iteration ${i}/${maxIterations}: ${nextStory.id} — ${nextStory.title}`, "info")

    const taskPrompt = [
      `You are working on project: ${currentPrd.project}`,
      `Branch: ${currentPrd.branchName}`,
      `Feature: ${currentPrd.description}`,
      "",
      "Your task is to implement this single user story:",
      "",
      `Story ID: ${nextStory.id}`,
      `Title: ${nextStory.title}`,
      `Description: ${nextStory.description}`,
      "Acceptance Criteria:",
      ...nextStory.acceptanceCriteria.map((c) => `- ${c}`),
      "",
      "After implementation, update prd.json to set passes: true for this story,",
      "then append your progress to progress.txt.",
    ].join("\n")

    const headBeforeIteration = getHeadSha(cwd)
    const status = startWorkerStatus(ctx, `Iteration ${i}/${maxIterations} ${nextStory.id} - ${nextStory.title}`, totalStartedAt)
    const worker = await runWorker(cwd, taskPrompt, workerSkillPath, ctx.signal, status.update)
    status.finish(worker.exitCode === 0 || worker.completed ? "completed" : "failed")

    if (worker.exitCode !== 0 && !worker.completed) {
      ctx.ui.notify(`Iteration ${i}: worker exited with code ${worker.exitCode}`, "warning")
    }

    if (worker.exitCode === 0 || worker.completed) {
      maybeAutoPushLatestCommit(ctx, cwd, headBeforeIteration)
    }

    if (worker.completed) {
      const finalPrd = readJsonFile(prdPath) as PrdJson | null
      if (finalPrd && allStoriesComplete(finalPrd)) {
        ctx.ui.notify(`Ralph complete — all stories done in ${i} iterations`, "info")
        return
      }
    }

    if (i < maxIterations) {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  const finalPrd = readJsonFile(prdPath) as PrdJson | null
  const stillRemaining = finalPrd ? finalPrd.userStories.filter((s) => !s.passes).length : "?"
  ctx.ui.notify(`Ralph reached max iterations (${maxIterations}). ${stillRemaining} stories remaining.`, "warning")
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    busyEditorState = undefined
    busyUiTheme = undefined
    busyEditorMounted = false
    ctx.ui.setWidget("ralph-progress", undefined)
    ctx.ui.setStatus("ralph", undefined)
    ctx.ui.setEditorComponent(undefined)
  })

  // Auto-install skills on first load
  ensureSkillsInstalled()

  // ── /ralph ──────────────────────────────────────────────────────────
  pi.registerCommand("ralph", {
    description: "Ralph autonomous agent. /ralph to start, /ralph status to check progress.",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd
      const prdPath = join(cwd, "prd.json")
      const progressPath = join(cwd, "progress.txt")
      const input = args.trim()
      // #region debug-point E:command-entry
      reportDebugEvent("E", "index.ts:command:ralph", "ralph command entered", {
        cwd,
        input,
        hasPrd: existsSync(prdPath),
        hasProgress: existsSync(progressPath),
      })
      // #endregion

      if (input !== "status") {
        ctx.ui.notify(`pi-ralph v${RALPH_PLUGIN_VERSION}`, "info")
      }

      if (input === "status") {
        const prd = readJsonFile(prdPath) as PrdJson | null
        if (!prd || !prd.userStories || !Array.isArray(prd.userStories)) {
          ctx.ui.notify("No prd.json found. Run /ralph <feature description> to set up a feature.", "warning")
          return
        }
        showStatus(ctx, prd)
        return
      }

      // ── Check for existing prd.json with unfinished stories ──────────
      if (existsSync(prdPath)) {
        const existingPrd = readJsonFile(prdPath) as PrdJson | null
        if (existingPrd?.userStories && Array.isArray(existingPrd.userStories)) {
          const remaining = existingPrd.userStories.filter((s) => !s.passes).length
          if (remaining > 0) {
            // Ask user: continue or start new?
            const resume = await ctx.ui.confirm(
              "Resume Previous Task?",
              [
                `Found unfinished task: ${existingPrd.description}`,
                `Branch: ${existingPrd.branchName}`,
                `Progress: ${existingPrd.userStories.length - remaining}/${existingPrd.userStories.length} stories complete`,
                `${remaining} stories remaining`,
                "",
                "Continue this task?",
              ].join("\n"),
            )

            if (resume) {
              // Continue existing task
              ctx.ui.notify([
                formatStatus(existingPrd),
                "",
                `Resuming — ${remaining} stories remaining`,
              ].join("\n"), "info")

              // Fall through to loop section below
              await maybeOfferInitialPush(ctx, cwd)
              return await startLoop(ctx, prdPath, progressPath, input)
            }
            // User chose "No" — fall through to new task flow
          }
        }
      }

      if (/^\d+$/.test(input)) {
        if (!existsSync(prdPath)) {
          ctx.ui.notify("No prd.json found. Run /ralph <feature description> first.", "warning")
          return
        }
        await maybeOfferInitialPush(ctx, cwd)
        return await startLoop(ctx, prdPath, progressPath, input)
      }

      if (!input) {
        const prd = readJsonFile(prdPath) as PrdJson | null
        if (prd?.userStories && Array.isArray(prd.userStories)) {
          showStatus(ctx, prd)
          return
        }
        ctx.ui.notify("No prd.json found. Run /ralph <feature description> to generate a PRD and start the loop.", "warning")
        return
      }

      // ── Step 1: Generate PRD + prd.json from description ─────────────
      ctx.ui.notify([
        "Ralph — Autonomous Agent Loop",
        "",
        "Step 1/4: Generate PRD and prd.json from feature description",
        `Feature: ${input}`,
      ].join("\n"), "info")

      const wizardSkillPath = resolveSkillPath("ralph-wizard", cwd)
      if (!wizardSkillPath) {
        const lookedIn = getSkillLookupPaths("ralph-wizard", cwd).map((p) => `- ${p}`).join("\n")
        ctx.ui.notify(`Could not find ralph-wizard skill.\n\nLooked in:\n${lookedIn}`, "error")
        return
      }

      // ── Step 2: Generate files via ralph-wizard ──────────────────────
      ctx.ui.notify("Step 2/4: Generating files...", "info")

      const totalStartedAt = Date.now()
      const task = `Feature description: ${input}`
      const status = startWorkerStatus(ctx, `Setup ${input}`, totalStartedAt)
      const worker = await runWorker(cwd, task, wizardSkillPath, ctx.signal, status.update)
      status.finish(worker.exitCode === 0 && existsSync(prdPath) ? "completed" : "failed")

      if (worker.exitCode !== 0 || !existsSync(prdPath)) {
        const output = getFinalOutput(worker.messages)
        ctx.ui.notify([
          "Failed to generate PRD files.",
          "",
          "Worker output:",
          output.slice(-500),
        ].join("\n"), "error")
        return
      }

      const prd = readJsonFile(prdPath) as PrdJson | null
      if (!prd || !prd.userStories || !Array.isArray(prd.userStories)) {
        ctx.ui.notify("prd.json was created but is invalid.", "error")
        return
      }

      // ── Step 3: Confirm PRD and stories ──────────────────────────────
      const total = prd.userStories.length
      const barWidth = 20
      const bar = "-".repeat(barWidth)

      const summary = [
        "Step 3/4: Review your PRD",
        "",
        `Project:   ${prd.project}`,
        `Branch:    ${prd.branchName}`,
        `Feature:   ${prd.description}`,
        "",
        `Stories:   ${total} user stories`,
        `[${bar}] 0%`,
        "",
        "Stories:",
        ...prd.userStories.map((s, i) => `  ${i + 1}. ${s.id} — ${s.title}`),
        "",
        "Accept to start the autonomous loop?",
      ].join("\n")

      const confirmed = await ctx.ui.confirm("Ralph Setup", summary)
      if (!confirmed) {
        ctx.ui.notify("Cancelled. prd.json was created but loop not started.", "warning")
        return
      }

      // ── Step 4: Start autonomous loop ────────────────────────────────
      ctx.ui.notify([
        "Setup complete.",
        "",
        formatStatus(prd),
        "",
        `Starting autonomous loop — ${total} stories.`,
      ].join("\n"), "info")

      await maybeOfferInitialPush(ctx, cwd)
      return await startLoop(ctx, prdPath, progressPath, input)
    },
  })
}

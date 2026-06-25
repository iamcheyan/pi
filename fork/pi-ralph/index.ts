/**
 * pi-ralph - Autonomous AI agent loop for pi
 *
 * Based on snarktank/ralph (https://github.com/snarktank/ralph).
 *
 * Single entry point: /ralph
 *
 *   /ralph → interactive setup / status / resume flow
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, readdirSync, unlinkSync, rmSync } from "node:fs"
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

interface DraftQuestion {
  question: string
  options: string[]
  reason?: string
}

interface DraftAnswer {
  question: string
  answer: string
}

interface DraftState {
  version: 2
  featureDescription: string
  understanding: string
  questionAnswers: DraftAnswer[]
  createdAt: string
  updatedAt: string
}

// Path bundle for a task directory — all handlers use this instead of separate prdPath/progressPath
interface TaskPaths {
  taskDir: string
  prdJson: string
  prdMd: string
  progress: string
  taskJson: string
}

interface IntakeResult {
  understanding: string
  questions: DraftQuestion[]
}

interface DraftQuestionsResult {
  type: "questions"
  questions: DraftQuestion[]
}

interface DraftReadyResult {
  type: "draft"
  prdPath: string
  title: string
  summary: string
}

type DraftGenerationResult = DraftQuestionsResult | DraftReadyResult

type CurrentTaskSummary = {
  prd: PrdJson
  storiesCompleted: number
  storiesTotal: number
  storiesRemaining: number
  nextStory: UserStory | null
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
    ].map((line) => truncateToWidth(line, width))
  }
}


// ============================================================================
// Self-install: symlink skills to ~/.pi/agent/skills/
// ============================================================================

const SKILLS = ["prd", "ralph", "ralph-worker", "ralph-wizard", "ralph-intake", "ralph-prd-draft"] as const

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
// Task directory management (new storage model)
// ============================================================================

function getRalphDir(cwd: string): string {
  return join(cwd, "ralph")
}

/** Ensure ralph/ directory exists with a .gitignore to protect sensitive files */
function ensureRalphDir(cwd: string): void {
  const ralphDir = getRalphDir(cwd)
  if (!existsSync(ralphDir)) {
    mkdirSync(ralphDir, { recursive: true })
  }
  const gitignorePath = join(ralphDir, ".gitignore")
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, [
      "# Ralph task files — safe to commit",
      "prd.json",
      "prd.md",
      "task.json",
      "",
      "# Progress logs may contain sensitive execution details — exclude by default",
      "progress.txt",
      "",
    ].join("\n"), "utf-8")
  }
}

function makeTaskDirName(slug: string): string {
  const now = new Date()
  const pad = (n: number, w: number) => String(n).padStart(w, "0")
  const yy = pad(now.getFullYear() % 100, 2)
  const mm = pad(now.getMonth() + 1, 2)
  const dd = pad(now.getDate(), 2)
  const hh = pad(now.getHours(), 2)
  const mi = pad(now.getMinutes(), 2)
  const ss = pad(now.getSeconds(), 2)
  const ms = pad(now.getMilliseconds(), 3)
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task"
  return `${yy}${mm}${dd}-${hh}${mi}${ss}-${ms}-${cleanSlug}`
}

function makeTaskPaths(cwd: string, taskDirName: string): TaskPaths {
  const taskDir = join(getRalphDir(cwd), taskDirName)
  return {
    taskDir,
    prdJson: join(taskDir, "prd.json"),
    prdMd: join(taskDir, "prd.md"),
    progress: join(taskDir, "progress.txt"),
    taskJson: join(taskDir, "task.json"),
  }
}

function listTaskDirs(cwd: string): string[] {
  const ralphDir = getRalphDir(cwd)
  if (!existsSync(ralphDir)) return []
  return readdirSync(ralphDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{6}-\d{6}-\d{3}-/.test(e.name))
    .map((e) => join(ralphDir, e.name))
    .sort((a, b) => b.localeCompare(a)) // newest first
}

function getTaskDirName(taskDir: string): string {
  const parts = taskDir.split("/")
  return parts[parts.length - 1] || taskDir
}

function getTaskSlug(taskDirName: string): string {
  const match = taskDirName.match(/^\d{6}-\d{6}-\d{3}-(.+)$/)
  return match ? match[1] : taskDirName
}

/** Find the newest task dir that has a prd.json with incomplete stories */
function findActiveTaskDir(cwd: string): TaskPaths | null {
  for (const dir of listTaskDirs(cwd)) {
    const paths: TaskPaths = {
      taskDir: dir,
      prdJson: join(dir, "prd.json"),
      prdMd: join(dir, "prd.md"),
      progress: join(dir, "progress.txt"),
      taskJson: join(dir, "task.json"),
    }
    const prd = readJsonFile(paths.prdJson) as PrdJson | null
    if (prd?.userStories && Array.isArray(prd.userStories) && !allStoriesComplete(prd)) {
      return paths
    }
  }
  return null
}

/** Find the newest completed task (all stories passed) for congratulatory display */
function findLatestCompletedTask(cwd: string): { paths: TaskPaths; prd: PrdJson } | null {
  for (const dir of listTaskDirs(cwd)) {
    const paths: TaskPaths = {
      taskDir: dir,
      prdJson: join(dir, "prd.json"),
      prdMd: join(dir, "prd.md"),
      progress: join(dir, "progress.txt"),
      taskJson: join(dir, "task.json"),
    }
    const prd = readJsonFile(paths.prdJson) as PrdJson | null
    if (prd?.userStories && Array.isArray(prd.userStories) && allStoriesComplete(prd)) {
      return { paths, prd }
    }
  }
  return null
}

/** Find the newest task dir that has task.json but no prd.json (draft in progress) */
function findDraftTaskDir(cwd: string): TaskPaths | null {
  for (const dir of listTaskDirs(cwd)) {
    const paths: TaskPaths = {
      taskDir: dir,
      prdJson: join(dir, "prd.json"),
      prdMd: join(dir, "prd.md"),
      progress: join(dir, "progress.txt"),
      taskJson: join(dir, "task.json"),
    }
    const task = readJsonFile(paths.taskJson)
    if (task && !existsSync(paths.prdJson)) {
      return paths
    }
  }
  return null
}

function readDraftStateFromTask(paths: TaskPaths): DraftState | null {
  const parsed = readJsonFile(paths.taskJson)
  if (!parsed || typeof parsed !== "object") return null
  // Accept both v1 (with prdPath) and v2 (without)
  if (!("featureDescription" in parsed) || typeof parsed.featureDescription !== "string") return null
  if (!("understanding" in parsed) || typeof parsed.understanding !== "string") return null
  if (!("questionAnswers" in parsed) || !Array.isArray(parsed.questionAnswers)) return null

  return {
    version: 2,
    featureDescription: parsed.featureDescription,
    understanding: parsed.understanding,
    questionAnswers: parsed.questionAnswers as DraftAnswer[],
    createdAt: "createdAt" in parsed && typeof parsed.createdAt === "string" ? parsed.createdAt : formatTimestamp(),
    updatedAt: "updatedAt" in parsed && typeof parsed.updatedAt === "string" ? parsed.updatedAt : formatTimestamp(),
  }
}

function writeDraftStateToTask(paths: TaskPaths, draft: DraftState): void {
  mkdirSync(paths.taskDir, { recursive: true })
  writeFileSync(paths.taskJson, `${JSON.stringify(draft, null, 2)}\n`, "utf-8")
}

/** Backward-compat: migrate old-style files in cwd/ into ralph/ directory */
function migrateLegacyTask(cwd: string): TaskPaths | null {
  const oldPrdPath = join(cwd, "prd.json")
  const oldProgressPath = join(cwd, "progress.txt")
  const oldDraftPath = join(cwd, ".ralph-draft.json")

  // Only migrate if old files exist and ralph/ doesn't
  if (!existsSync(oldPrdPath) && !existsSync(oldDraftPath)) return null
  if (existsSync(getRalphDir(cwd))) return null

  const prd = readJsonFile(oldPrdPath) as PrdJson | null
  const slug = prd?.project
    ? prd.project.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
    : "migrated"

  const dirName = makeTaskDirName(slug)
  const paths = makeTaskPaths(cwd, dirName)
  ensureRalphDir(cwd)
  mkdirSync(paths.taskDir, { recursive: true })

  if (existsSync(oldPrdPath)) copyFileSync(oldPrdPath, paths.prdJson)
  if (existsSync(oldProgressPath)) copyFileSync(oldProgressPath, paths.progress)

  // Migrate draft state
  if (existsSync(oldDraftPath)) {
    const oldDraft = readJsonFile(oldDraftPath) as Record<string, unknown> | null
    if (oldDraft) {
      const newDraft: DraftState = {
        version: 2,
        featureDescription: (oldDraft.featureDescription as string) ?? "",
        understanding: (oldDraft.understanding as string) ?? "",
        questionAnswers: (oldDraft.questionAnswers as DraftAnswer[]) ?? [],
        createdAt: (oldDraft.createdAt as string) ?? formatTimestamp(),
        updatedAt: (oldDraft.updatedAt as string) ?? formatTimestamp(),
      }
      writeFileSync(paths.taskJson, `${JSON.stringify(newDraft, null, 2)}\n`, "utf-8")
    }
    unlinkSync(oldDraftPath)
  }

  // Migrate archive directory
  const oldArchiveDir = join(cwd, "archive")
  if (existsSync(oldArchiveDir)) {
    const archiveDest = join(paths.taskDir, "archive")
    mkdirSync(archiveDest, { recursive: true })
    for (const entry of readdirSync(oldArchiveDir, { withFileTypes: true })) {
      const src = join(oldArchiveDir, entry.name)
      const dest = join(archiveDest, entry.name)
      if (entry.isDirectory()) {
        // Skip — old archive subdirectories are not needed in new model
      } else {
        copyFileSync(src, dest)
      }
    }
  }

  return paths
}

function getCurrentTaskSummary(prd: PrdJson): CurrentTaskSummary {
  const storiesCompleted = prd.userStories.filter((story) => story.passes).length
  const storiesTotal = prd.userStories.length
  return {
    prd,
    storiesCompleted,
    storiesTotal,
    storiesRemaining: storiesTotal - storiesCompleted,
    nextStory: findNextStory(prd),
  }
}

function getProgressTail(progressPath: string, maxLines = 20): string {
  if (!existsSync(progressPath)) return "No progress log was archived."
  const lines = readFileSync(progressPath, "utf-8").split("\n")
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n").trim() || "No progress log was archived."
}

function formatDraftSummary(draft: DraftState, taskDirName?: string): string {
  const lines = [
    "Draft PRD awaiting review",
    `Feature:   ${draft.featureDescription}`,
  ]

  if (taskDirName) {
    lines.push(`Dir:       ralph/${taskDirName}/`)
  }

  lines.push(`Updated:   ${draft.updatedAt}`)
  lines.push("")
  lines.push("Ralph's understanding:")
  lines.push(draft.understanding)

  if (draft.questionAnswers.length > 0) {
    lines.push("")
    lines.push("Clarifications:")
    for (const answer of draft.questionAnswers) {
      lines.push(`- ${answer.question}`)
      lines.push(`  ${answer.answer}`)
    }
  }

  return lines.join("\n")
}

function formatHomeSummary(
  activePrd: PrdJson | null,
  activeDirName: string | null,
  draftState: DraftState | null,
  draftDirName: string | null,
  completedPrd: PrdJson | null,
  completedDirName: string | null,
  taskCount: number,
): string {
  const lines = [
    `Ralph Home (pi-ralph v${RALPH_PLUGIN_VERSION})`,
    "",
  ]

  if (activePrd?.userStories && Array.isArray(activePrd.userStories)) {
    const summary = getCurrentTaskSummary(activePrd)
    lines.push(`Current:   ${summary.prd.description}`)
    lines.push(`Branch:    ${summary.prd.branchName}`)
    lines.push(`Dir:       ralph/${activeDirName}/`)
    lines.push(`Progress:  ${summary.storiesCompleted}/${summary.storiesTotal} stories complete`)
    if (summary.nextStory) {
      lines.push(`Next:      ${summary.nextStory.id} — ${summary.nextStory.title}`)
    } else {
      lines.push("Next:      all stories complete")
    }
  } else if (completedPrd?.userStories && completedDirName) {
    const total = completedPrd.userStories.length
    lines.push(`✅ Last task completed: ${completedPrd.description}`)
    lines.push(`   Dir: ralph/${completedDirName}/  (${total}/${total} stories)`)
  } else {
    lines.push("Current:   no active Ralph task")
  }

  if (draftState && draftDirName) {
    lines.push(`Draft:     ralph/${draftDirName}/`)
    lines.push(`Feature:   ${draftState.featureDescription.slice(0, 60)}`)
  }

  lines.push(`History:   ${taskCount} task(s) in ralph/`)
  return lines.join("\n")
}

function formatResumeSummary(prd: PrdJson): string {
  const summary = getCurrentTaskSummary(prd)
  const lines = [
    `Task: ${summary.prd.description}`,
    `Branch: ${summary.prd.branchName}`,
    `Progress: ${summary.storiesCompleted}/${summary.storiesTotal} stories complete`,
  ]

  if (summary.nextStory) {
    lines.push(`Next story: ${summary.nextStory.id} — ${summary.nextStory.title}`)
    lines.push("Reason: the next unpassed story becomes the next iteration target.")
  } else {
    lines.push("Next story: none")
    lines.push("Reason: all stories are already marked as passed.")
  }

  return lines.join("\n")
}

// ============================================================================
// Git helpers
// ============================================================================

type GitCommandResult = {
  ok: boolean
  stdout: string
  stderr: string
}

function isGitRepo(cwd: string): boolean {
  return runGitCommand(cwd, ["rev-parse", "--git-dir"]).ok
}

async function ensureGitRepo(ctx: ExtensionCommandContext): Promise<boolean> {
  if (isGitRepo(ctx.cwd)) return true

  const confirmed = await ctx.ui.confirm(
    "初始化 Git 仓库？",
    [
      "当前目录不是 Git 仓库。",
      "",
      "Ralph 依赖 Git 来追踪代码变更、提交进度、方便回溯。",
      "需要在此目录初始化 Git 仓库吗？",
      "",
      `目录: ${ctx.cwd}`,
    ].join("\n"),
    { signal: ctx.signal },
  )

  if (!confirmed) {
    ctx.ui.notify("已取消。Ralph 需要 Git 仓库才能正常工作。", "warning")
    return false
  }

  const initResult = runGitCommand(ctx.cwd, ["init"])
  if (!initResult.ok) {
    ctx.ui.notify(`Git 初始化失败: ${initResult.stderr}`, "error")
    return false
  }

  // Make an initial commit so git has a baseline
  runGitCommand(ctx.cwd, ["add", "-A"])
  runGitCommand(ctx.cwd, ["commit", "-m", "init: ralph initial commit", "--allow-empty"])

  ctx.ui.notify("✅ Git 仓库已初始化", "info")
  return true
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


async function promptFeatureDescription(ctx: ExtensionCommandContext): Promise<string | undefined> {
  while (true) {
    const value = await ctx.ui.input(
      "Feature Description",
      "描述需求，可包含 URL 或本地文档路径（如 ./docs/spec.md）",
      { signal: ctx.signal },
    )
    if (value === undefined) return undefined

    const trimmed = value.trim()
    if (trimmed) return trimmed

    ctx.ui.notify("Feature description cannot be empty.", "warning")
  }
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

  return new Promise((resolve) => {
    const invocation = getPiInvocation(args)
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let buffer = ""
    let stepCount = 0
    let resolved = false

    const safeResolve = (r: WorkerResult) => {
      if (resolved) return
      resolved = true
      resolve(r)
    }

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
        emitProgress(`message:${msg.role}`)

        if (msg.role === "assistant") {
          for (const part of msg.content) {
            if (part.type === "text" && part.text.includes("<promise>COMPLETE</promise>")) {
              result.completed = true
              // Worker signaled done — flush buffer and resolve after short delay
              setTimeout(() => {
                if (buffer.trim()) {
                  processLine(buffer.trim())
                  buffer = ""
                }
                safeResolve(result)
              }, 1000)
            }
          }
        }
      }

      if (event.type === "tool_result_end" && event.message) {
        result.messages.push(event.message as Message)
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
      emitProgress("stderr")
    })

    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer)
      result.exitCode = code ?? 0

      // Flush remaining buffer — last JSON event may not end with newline
      if (buffer.trim()) {
        processLine(buffer.trim())
        buffer = ""
      }

      safeResolve(result)
    })

    proc.on("error", () => {
      result.exitCode = 1
      safeResolve(result)
    })

    if (signal) {
      const killProc = () => {
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

function extractJsonObject(text: string): string | null {
  const stripped = text
    // Strip thinking blocks — model reasoning contains { } that break brace matching
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<promise>COMPLETE<\/promise>/g, "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()

  // Find the first complete top-level JSON object by tracking brace depth
  let start = -1
  let depth = 0
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] === "{") {
      if (depth === 0) start = i
      depth++
    } else if (stripped[i] === "}") {
      depth--
      if (depth === 0 && start !== -1) {
        return stripped.slice(start, i + 1)
      }
    }
  }

  // Fallback: greedy approach
  const firstBrace = stripped.indexOf("{")
  const lastBrace = stripped.lastIndexOf("}")
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) return null
  return stripped.slice(firstBrace, lastBrace + 1)
}

function parseWorkerJsonOutput<T>(text: string): T | null {
  const jsonText = extractJsonObject(text)
  if (!jsonText) return null
  try {
    return JSON.parse(jsonText) as T
  } catch {
    return null
  }
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

// Visible width calculation: CJK chars = 2 cols, ANSI codes = 0 cols
function visibleWidth(str: string): number {
  let w = 0
  let i = 0
  while (i < str.length) {
    if (str[i] === "\x1b") {
      const end = str.indexOf("m", i)
      if (end !== -1) { i = end + 1; continue }
    }
    const cp = str.codePointAt(i)!
    const charW = (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x2fffd) ||
      (cp >= 0x30000 && cp <= 0x3fffd) ? 2 : 1
    w += charW
    i += cp > 0xffff ? 2 : 1
  }
  return w
}

function truncateToWidth(str: string, maxWidth: number): string {
  let w = 0
  let i = 0
  while (i < str.length && w < maxWidth) {
    if (str[i] === "\x1b") {
      const end = str.indexOf("m", i)
      if (end !== -1) { i = end + 1; continue }
    }
    const cp = str.codePointAt(i)!
    const charW = (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x2fffd) ||
      (cp >= 0x30000 && cp <= 0x3fffd) ? 2 : 1
    if (w + charW > maxWidth) break
    w += charW
    i += cp > 0xffff ? 2 : 1
  }
  return str.slice(0, i)
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

  // Truncate label to fit terminal width — avoid TUI crash from overlong lines
  const termWidth = process.stdout.columns ?? 80
  const prefix = `Ralph ${phase}: `
  const suffix = ` (round ${roundElapsed} | total ${totalElapsed})${progressSuffix}`
  const fixedWidth = visibleWidth(prefix) + visibleWidth(suffix)
  const maxLabelWidth = Math.max(20, termWidth - fixedWidth)
  const truncatedLabel = visibleWidth(label) > maxLabelWidth
    ? truncateToWidth(label, maxLabelWidth - 1) + "…"
    : label
  const text = `${prefix}${truncatedLabel}${suffix}`
  busyEditorState = { phase, label, roundElapsed, totalElapsed, progress }
  busyUiTheme = ctx.ui.theme
  ctx.ui.setStatus("ralph", text)
  ctx.ui.setWidget("ralph-progress", undefined)

  if (phase === "running") {
    ctx.ui.setWorkingVisible(true)
    ctx.ui.setWorkingMessage(text)
    ctx.ui.setWorkingIndicator({ frames: [...WORKER_SPINNER_FRAMES], intervalMs: 120 })
  } else {
    ctx.ui.setWorkingVisible(false)
    ctx.ui.setWorkingMessage()
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

async function runJsonSkillWorker<T>(
  ctx: ExtensionCommandContext,
  skillName: typeof SKILLS[number],
  taskPrompt: string,
  statusLabel: string,
): Promise<{ data: T; rawOutput: string } | null> {
  const skillFilePath = resolveSkillPath(skillName, ctx.cwd)
  if (!skillFilePath) {
    const lookedIn = getSkillLookupPaths(skillName, ctx.cwd).map((path) => `- ${path}`).join("\n")
    ctx.ui.notify(`Could not find ${skillName} skill.\n\nLooked in:\n${lookedIn}`, "error")
    return null
  }

  const totalStartedAt = Date.now()
  const status = startWorkerStatus(ctx, statusLabel, totalStartedAt)
  const worker = await runWorker(ctx.cwd, taskPrompt, skillFilePath, ctx.signal, status.update)
  status.finish(worker.exitCode === 0 || worker.completed ? "completed" : "failed")

  let rawOutput = getFinalOutput(worker.messages)

  // First attempt: check if worker succeeded and output is valid JSON
  let data = parseWorkerJsonOutput<T>(rawOutput)

  // Retry once if JSON parsing failed — model may have ignored skill instructions
  if (!data && (worker.exitCode === 0 || worker.completed)) {
    ctx.ui.notify(`⚠️ ${skillName} 输出格式不正确，正在重试...`, "warning")

    const retryPrompt = [
      taskPrompt,
      "",
      "IMPORTANT: Your previous response was not valid JSON.",
      "You MUST output ONLY a raw JSON object matching the required schema.",
      "Do NOT ask questions. Do NOT output prose. Do NOT wrap in code blocks.",
      "Just output the JSON object and nothing else.",
    ].join("\n")

    const retryStatus = startWorkerStatus(ctx, `${statusLabel} (retry)`, Date.now())
    const retryWorker = await runWorker(ctx.cwd, retryPrompt, skillFilePath, ctx.signal, retryStatus.update)
    retryStatus.finish(retryWorker.exitCode === 0 || retryWorker.completed ? "completed" : "failed")

    rawOutput = getFinalOutput(retryWorker.messages)
    data = parseWorkerJsonOutput<T>(rawOutput)
  }

  if (!data) {
    ctx.ui.notify([
      `❌ ${skillName} 输出解析失败`,
      "",
      "Worker output:",
      rawOutput.slice(-500),
    ].join("\n"), "error")
    return null
  }

  // Deep-clone to ensure the returned object is mutable —
  // JSON.parse results can be frozen in some runtime contexts
  return { data: JSON.parse(JSON.stringify(data)) as T, rawOutput }
}

async function promptCustomClarification(ctx: ExtensionCommandContext, question: string): Promise<string | undefined> {
  while (true) {
    const value = await ctx.ui.input("Clarification", question, { signal: ctx.signal })
    if (value === undefined) return undefined
    const trimmed = value.trim()
    if (trimmed) return trimmed
    ctx.ui.notify("Clarification cannot be empty.", "warning")
  }
}

async function askClarifyingQuestions(
  ctx: ExtensionCommandContext,
  questions: DraftQuestion[],
): Promise<DraftAnswer[] | undefined> {
  const answers: DraftAnswer[] = []

  for (const question of questions) {
    if (question.options.length === 0) {
      const answer = await promptCustomClarification(ctx, question.question)
      if (answer === undefined) return undefined
      answers.push({ question: question.question, answer })
      continue
    }

    const options = [...question.options, "Other (enter manually)"]
    const choice = await ctx.ui.select(question.question, options, { signal: ctx.signal })
    if (!choice) return undefined

    if (choice === "Other (enter manually)") {
      const answer = await promptCustomClarification(ctx, question.question)
      if (answer === undefined) return undefined
      answers.push({ question: question.question, answer })
      continue
    }

    answers.push({ question: question.question, answer: choice })
  }

  return answers
}

function formatDraftAnswers(questionAnswers: DraftAnswer[]): string {
  if (questionAnswers.length === 0) return "No clarifications were needed."
  return questionAnswers.map((answer, index) => [
    `${index + 1}. ${answer.question}`,
    `Answer: ${answer.answer}`,
  ].join("\n")).join("\n\n")
}

function formatStoriesReviewSummary(prd: PrdJson): string {
  const total = prd.userStories.length
  const bar = "-".repeat(20)

  return [
    "Stories generated from the confirmed PRD",
    "",
    `Project:   ${prd.project}`,
    `Branch:    ${prd.branchName}`,
    `Feature:   ${prd.description}`,
    "",
    `Stories:   ${total} user stories`,
    `[${bar}] 0%`,
    "",
    "Stories:",
    ...prd.userStories.map((story, index) => `  ${index + 1}. ${story.id} — ${story.title}`),
  ].join("\n")
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
  const summary = getCurrentTaskSummary(prd)

  const lines = [
    `Plugin:    pi-ralph v${RALPH_PLUGIN_VERSION}`,
    `Project:   ${prd.project}`,
    `Branch:    ${prd.branchName}`,
    `Feature:   ${prd.description}`,
    `Progress:  ${summary.storiesCompleted}/${summary.storiesTotal} stories complete`,
    "",
  ]

  if (summary.storiesRemaining > 0) {
    lines.push("Remaining stories:")
    for (const s of prd.userStories.filter((s) => !s.passes)) {
      lines.push(`  ${s.id} [P${s.priority}] ${s.title}`)
    }
  }

  return lines.join("\n")
}

async function handleResumeCurrentTask(
  ctx: ExtensionCommandContext,
  paths: TaskPaths,
  prd: PrdJson,
): Promise<boolean> {
  if (!(await ensureGitRepo(ctx))) return false

  showStatus(ctx, prd)

  const shouldResume = await ctx.ui.confirm(
    "Resume Current Task?",
    [
      formatResumeSummary(prd),
      "",
      `目录: ralph/${getTaskDirName(paths.taskDir)}/`,
      "",
      "Continue this Ralph task now?",
    ].join("\n"),
    { signal: ctx.signal },
  )
  if (!shouldResume) return false

  await maybeOfferInitialPush(ctx, ctx.cwd)
  await startLoop(ctx, paths, prd.userStories.length)
  return true
}

async function handleStartNewTask(
  ctx: ExtensionCommandContext,
  activePaths: TaskPaths | null,
  activePrd: PrdJson | null,
  draftPaths: TaskPaths | null,
  draftState: DraftState | null,
): Promise<boolean> {
  const cwd = ctx.cwd

  // Ensure we're in a git repo — ralph depends on git for tracking changes
  if (!(await ensureGitRepo(ctx))) return false

  // If there's an active task or draft, inform the user (no archiving needed — new task gets a new directory)
  if (activePrd || draftState) {
    const lines: string[] = ["已存在进行中的任务，但每个任务有独立目录，不会丢失。"]
    if (activePrd) {
      const summary = getCurrentTaskSummary(activePrd)
      lines.push(
        "",
        `当前任务: ${activePrd.description}`,
        `目录: ralph/${getTaskDirName(activePaths!.taskDir)}/`,
        `进度: ${summary.storiesCompleted}/${summary.storiesTotal} stories`,
      )
    }
    if (draftState) {
      lines.push(`草稿目录: ralph/${getTaskDirName(draftPaths!.taskDir)}/`)
    }
    lines.push("", "将创建新的任务目录。")

    const confirmed = await ctx.ui.confirm("开始新任务？", lines.join("\n"), { signal: ctx.signal })
    if (!confirmed) {
      ctx.ui.notify("已取消。", "warning")
      return false
    }
  }

  const featureDescription = await promptFeatureDescription(ctx)
  if (featureDescription === undefined) {
    ctx.ui.notify("Cancelled before creating a new Ralph task.", "warning")
    return false
  }

  // Truncate long lines for display to avoid TUI crash
  const termWidth = process.stdout.columns ?? 80
  const displayDesc = featureDescription
    .split("\n")
    .map((line) => truncateToWidth(line, termWidth - 4))
    .join("\n")

  ctx.ui.notify([
    "📋 Step 1/4: 需求已记录",
    "",
    displayDesc,
  ].join("\n"), "warning")

  // ── Intake: AI understands + asks 1-5 questions ─────────────────────
  const intakeResult = await runJsonSkillWorker<IntakeResult>(
    ctx,
    "ralph-intake",
    `Feature description: ${featureDescription}`,
    `🧠 AI 正在理解你的需求...`,
  )
  if (!intakeResult) {
    ctx.ui.notify("❌ 理解失败 — AI 无法解析需求，请重试", "error")
    return false
  }

  const understanding = intakeResult.data.understanding
  const questions = intakeResult.data.questions ?? []

  ctx.ui.notify([
    "🧠 AI 的理解",
    "",
    understanding,
  ].join("\n"), "warning")

  // Ask questions one at a time (1-5 based on AI's judgment)
  const allAnswers: DraftAnswer[] = []
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]
    ctx.ui.notify(`💬 问题 ${i + 1}/${questions.length}: ${q.question}`, "warning")

    const answer = await askClarifyingQuestions(ctx, [q])
    if (answer === undefined) {
      ctx.ui.notify("Cancelled during clarification.", "warning")
      return false
    }
    allAnswers.push(...answer)
  }

  // ── Create task directory ───────────────────────────────────────────
  const slug = understanding.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task"
  const taskDirName = makeTaskDirName(slug)
  ensureRalphDir(cwd)
  const paths = makeTaskPaths(cwd, taskDirName)
  mkdirSync(paths.taskDir, { recursive: true })

  ctx.ui.notify([
    `📁 任务目录: ralph/${taskDirName}/`,
    "⚠️ 请勿在需求描述或回答中包含 API key、密码等敏感信息（文件会被 git 跟踪）",
  ].join("\n"), "warning")

  // Save draft state to task directory
  const now = formatTimestamp()
  const draftStateNew: DraftState = {
    version: 2,
    featureDescription,
    understanding,
    questionAnswers: allAnswers,
    createdAt: now,
    updatedAt: now,
  }
  writeDraftStateToTask(paths, draftStateNew)

  // ── Generate PRD draft ──────────────────────────────────────────────
  const allClarifications = formatDraftAnswers(allAnswers)
  let draftRound = 0
  let draftResult: { data: DraftReadyResult; rawOutput: string } | null = null

  // Loop: AI may ask more questions before generating the PRD
  while (true) {
    draftRound += 1
    const draftPrompt = [
      `Feature description: ${featureDescription}`,
      "",
      "Ralph understanding:",
      understanding,
      "",
      "Clarifications:",
      allClarifications,
      "",
      `Save the PRD draft to: ${paths.prdMd}`,
    ].join("\n")

    ctx.ui.notify(`📝 Step 3/4: AI 正在${draftRound > 1 ? "重新" : ""}生成 PRD 文档...`, "warning")

    const draftWorkerResult = await runJsonSkillWorker<DraftGenerationResult>(
      ctx,
      "ralph-prd-draft",
      draftPrompt,
      draftRound > 1 ? `📝 重新撰写 PRD (第 ${draftRound} 轮)...` : `📝 正在撰写 PRD...`,
    )
    if (!draftWorkerResult) {
      return false
    }

    // Check if AI wants to ask more questions
    if (draftWorkerResult.data.type === "questions") {
      const qs = (draftWorkerResult.data as DraftQuestionsResult).questions
      if (!qs || qs.length === 0) {
        ctx.ui.notify("❌ AI 返回了空问题列表", "error")
        return false
      }

      ctx.ui.notify(`💬 AI 还有 ${qs.length} 个问题想确认（第 ${draftRound + 1} 轮）`, "warning")

      const moreAnswers = await askClarifyingQuestions(ctx, qs)
      if (moreAnswers === undefined) {
        ctx.ui.notify("Cancelled during clarification.", "warning")
        return false
      }

      // Append new clarifications and loop
      allClarifications += "\n\n" + formatDraftAnswers(moreAnswers)
      continue
    }

    // AI is ready with the draft
    draftResult = draftWorkerResult as { data: DraftReadyResult; rawOutput: string }
    break
  }

  // The PRD draft may have been saved by the worker — check both the worker's reported path and our expected path
  const workerPrdPath = draftResult.data.prdPath.startsWith("/")
    ? draftResult.data.prdPath
    : join(cwd, draftResult.data.prdPath)
  const prdMdExists = existsSync(paths.prdMd) || existsSync(workerPrdPath)

  if (!prdMdExists) {
    ctx.ui.notify([
      "❌ PRD 生成失败 — 文件未找到",
      "",
      `Expected: ralph/${taskDirName}/prd.md`,
      `Worker reported: ${draftResult.data.prdPath}`,
    ].join("\n"), "error")
    return false
  }

  // If worker saved to a different path, copy it to our task directory
  if (!existsSync(paths.prdMd) && existsSync(workerPrdPath)) {
    copyFileSync(workerPrdPath, paths.prdMd)
  }

  ctx.ui.notify(`✅ Step 4/4: PRD 文档已生成 → ralph/${taskDirName}/prd.md`, "warning")

  // ── Convert draft to prd.json ──────────────────────────────────────
  const converterSkillPath = resolveSkillPath("ralph", cwd)
  if (!converterSkillPath) {
    ctx.ui.notify(`Could not find ralph skill for PRD conversion.`, "error")
    return false
  }

  // ── Convert with auto-recovery on failure ──────────────────────────
  const MAX_CONVERT_ATTEMPTS = 3
  let prd: PrdJson | null = null

  for (let attempt = 1; attempt <= MAX_CONVERT_ATTEMPTS; attempt++) {
    ctx.ui.notify(`🔄 正在将草稿转换为 prd.json...${attempt > 1 ? ` (第 ${attempt} 次尝试)` : ""}`, "warning")

    const convertStatus = startWorkerStatus(ctx, `Convert ralph/${taskDirName}/prd.md`, Date.now())
    // Tell the converter to generate prd.json inside the task directory
    const convertWorker = await runWorker(
      cwd,
      `PRD file: ${paths.prdMd}\n\nIMPORTANT: Save the generated prd.json to: ${paths.prdJson}`,
      converterSkillPath,
      ctx.signal,
      convertStatus.update,
    )
    convertStatus.finish(convertWorker.exitCode === 0 && existsSync(paths.prdJson) ? "completed" : "failed")

    // Check if conversion succeeded
    if (convertWorker.exitCode === 0 && existsSync(paths.prdJson)) {
      prd = readJsonFile(paths.prdJson) as PrdJson | null
      if (prd?.userStories && Array.isArray(prd.userStories)) {
        break // Success!
      }
    }

    // Conversion failed — AI attempts to fix
    if (attempt < MAX_CONVERT_ATTEMPTS) {
      const workerOutput = getFinalOutput(convertWorker.messages)
      const prdContent = readFileSync(paths.prdMd, "utf-8").slice(0, 3000)

      ctx.ui.notify(`🔧 AI 正在诊断并修复转换问题...`, "warning")

      const fixPrompt = [
        "PRD conversion to prd.json failed. Diagnose and fix the issue.",
        "",
        "## PRD markdown file (source):",
        prdContent,
        "",
        "## Conversion worker output:",
        workerOutput?.slice(-1000) || "(empty)",
        "",
        `## Error: exitCode=${convertWorker.exitCode}, prd.json exists=${existsSync(paths.prdJson)}`,
        "",
        "## Your task:",
        "1. Read the PRD markdown at: " + paths.prdMd,
        `2. Generate the correct prd.json at: ${paths.prdJson}`,
        "3. The prd.json must have: project, branchName, description, userStories[]",
        "4. Each story needs: id, title, description, acceptanceCriteria[], priority, passes=false, notes=''",
        "5. Do NOT ask questions. Just fix the file.",
        "",
        "Output JSON only: {\"fixed\": true} then <promise>COMPLETE</promise>",
      ].join("\n")

      const fixStatus = startWorkerStatus(ctx, `Fix prd.json (attempt ${attempt})`, Date.now())
      const fixWorker = await runWorker(cwd, fixPrompt, converterSkillPath, ctx.signal, fixStatus.update)
      fixStatus.finish(fixWorker.completed ? "completed" : "failed")

      // Check if fix created prd.json
      if (existsSync(paths.prdJson)) {
        prd = readJsonFile(paths.prdJson) as PrdJson | null
        if (prd?.userStories && Array.isArray(prd.userStories)) {
          ctx.ui.notify("✅ AI 已自动修复 prd.json", "warning")
          break
        }
      }

      ctx.ui.notify(`⚠️ 修复尝试 ${attempt} 未成功，将重试转换...`, "warning")
    }
  }

  if (!prd?.userStories || !Array.isArray(prd.userStories)) {
    ctx.ui.notify([
      "❌ 转换失败，AI 也无法修复",
      "",
      `PRD 草稿: ralph/${taskDirName}/prd.md`,
      "你可以手动编辑 PRD 后通过 /ralph → Continue PRD draft 继续",
    ].join("\n"), "error")
    return false
  }

  // ── Rich summary before starting execution ─────────────────────────
  const storyCount = prd.userStories.length
  const storyList = prd.userStories.map((s, i) => `  ${i + 1}. ${s.id} — ${s.title}`).join("\n")

  const summaryLines = [
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "📋 任务总览",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    `项目: ${prd.project}`,
    `分支: ${prd.branchName}`,
    `功能: ${prd.description}`,
    "",
    "🧠 需求理解:",
    understanding.slice(0, 200) + (understanding.length > 200 ? "..." : ""),
    "",
    `📝 AI 共问了 ${allAnswers.length} 个问题，需求已充分理解`,
    "",
    `📁 任务目录: ralph/${taskDirName}/`,
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `🚀 执行计划: ${storyCount} 个用户故事`,
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    storyList,
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "⚠️  注意事项",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    `• 执行时间可能较长（${storyCount} 个故事，预计数小时）`,
    "• 过程中可随时按 Ctrl+C 中断",
    "• 中断后下次运行 /ralph → Continue current task 即可继续",
    "• 每个故事完成后会自动提交代码",
  ]

  // Let the TUI settle after the conversion worker's overlay was dismissed.
  await new Promise((r) => setTimeout(r, 300))

  const confirmed = await ctx.ui.select(
    "确认开始执行？\n\n" + summaryLines.join("\n"),
    ["✅ 开始执行", "❌ 取消"],
    { signal: ctx.signal },
  )

  if (confirmed !== "✅ 开始执行") {
    ctx.ui.notify([
      "已取消。PRD 已保存，可通过 /ralph 继续。",
      `目录: ralph/${taskDirName}/`,
    ].join("\n"), "warning")
    return true
  }

  // ── Start execution ────────────────────────────────────────────────
  await maybeOfferInitialPush(ctx, cwd)
  await startLoop(ctx, paths, storyCount)
  return true
}

async function handleContinueDraft(
  ctx: ExtensionCommandContext,
  paths: TaskPaths,
  draft: DraftState,
): Promise<boolean> {
  if (!(await ensureGitRepo(ctx))) return false

  const cwd = ctx.cwd

  if (!existsSync(paths.prdMd)) {
    // PRD draft was never generated (or was deleted) — offer to regenerate
    const choice = await ctx.ui.select(
      "PRD 草稿缺失",
      [
        `PRD 草稿文件未找到: ralph/${getTaskDirName(paths.taskDir)}/prd.md`,
        "",
        `需求: ${draft.featureDescription}`,
        `理解: ${draft.understanding.slice(0, 100)}...`,
        `问答: ${draft.questionAnswers.length} 个问题已回答`,
        "",
        "已有完整的理解记录，可以重新生成 PRD 而不需要重新回答问题。",
      ].join("\n"),
      ["重新生成 PRD", "清除此任务", "返回"],
      { signal: ctx.signal },
    )

    if (choice === "清除此任务") {
      rmSync(paths.taskDir, { recursive: true, force: true })
      ctx.ui.notify("已清除草稿任务目录。", "warning")
      return false
    }

    if (choice === "重新生成 PRD") {
      // Regenerate PRD from saved understanding and answers
      const allClarifications = formatDraftAnswers(draft.questionAnswers)
      const draftPrompt = [
        `Feature description: ${draft.featureDescription}`,
        "",
        "Ralph understanding:",
        draft.understanding,
        "",
        "Clarifications:",
        allClarifications,
        "",
        `Save the PRD draft to: ${paths.prdMd}`,
      ].join("\n")

      const regenResult = await runJsonSkillWorker<DraftGenerationResult>(
        ctx,
        "ralph-prd-draft",
        draftPrompt,
        `📝 重新生成 PRD...`,
      )
      if (!regenResult) {
        ctx.ui.notify("❌ PRD 重新生成失败", "error")
        return false
      }

      // If AI still wants to ask questions, handle them
      if (regenResult.data.type === "questions") {
        const qs = (regenResult.data as DraftQuestionsResult).questions
        if (qs && qs.length > 0) {
          const moreAnswers = await askClarifyingQuestions(ctx, qs)
          if (moreAnswers) {
            draft.questionAnswers.push(...moreAnswers)
            writeDraftStateToTask(paths, draft)
          }
        }
        ctx.ui.notify("AI 需要更多信息，请重新运行 /ralph 继续。", "warning")
        return false
      }

      // Check if PRD was generated
      if (!existsSync(paths.prdMd)) {
        ctx.ui.notify("❌ PRD 重新生成失败 — 文件未创建", "error")
        return false
      }

      ctx.ui.notify("✅ PRD 已重新生成", "warning")
      // Fall through to the conversion step below
    } else {
      // "返回"
      return false
    }
  }

  ctx.ui.notify(formatDraftSummary(draft, getTaskDirName(paths.taskDir)), "info")

  const readyToConvert = await ctx.ui.confirm(
    "Continue PRD Draft?",
    [
      formatDraftSummary(draft),
      "",
      `目录: ralph/${getTaskDirName(paths.taskDir)}/`,
      "",
      "Have you reviewed and updated this PRD draft file?",
      "Convert it to prd.json now?",
    ].join("\n"),
    { signal: ctx.signal },
  )

  if (!readyToConvert) {
    ctx.ui.notify([
      "PRD draft is still waiting for your review.",
      "",
      `Draft file: ralph/${getTaskDirName(paths.taskDir)}/prd.md`,
      "Edit the markdown file, then run /ralph again and choose \"Continue PRD draft\".",
    ].join("\n"), "info")
    return true
  }

  const converterSkillPath = resolveSkillPath("ralph", cwd)
  if (!converterSkillPath) {
    const lookedIn = getSkillLookupPaths("ralph", cwd).map((path) => `- ${path}`).join("\n")
    ctx.ui.notify(`Could not find ralph skill.\n\nLooked in:\n${lookedIn}`, "error")
    return false
  }

  const totalStartedAt = Date.now()
  const status = startWorkerStatus(ctx, `Convert ralph/${getTaskDirName(paths.taskDir)}/prd.md`, totalStartedAt)
  const worker = await runWorker(
    cwd,
    `PRD file: ${paths.prdMd}\n\nIMPORTANT: Save the generated prd.json to: ${paths.prdJson}`,
    converterSkillPath,
    ctx.signal,
    status.update,
  )
  status.finish(worker.exitCode === 0 && existsSync(paths.prdJson) ? "completed" : "failed")

  if (worker.exitCode !== 0 || !existsSync(paths.prdJson)) {
    const output = getFinalOutput(worker.messages)
    ctx.ui.notify([
      "Failed to convert the reviewed PRD draft into prd.json.",
      "",
      "Worker output:",
      output.slice(-800),
    ].join("\n"), "error")
    return false
  }

  const prd = readJsonFile(paths.prdJson) as PrdJson | null
  if (!prd?.userStories || !Array.isArray(prd.userStories)) {
    ctx.ui.notify("prd.json was created but is invalid.", "error")
    return false
  }

  ctx.ui.notify([
    "Step 4/5: prd.json generated from the confirmed draft",
    "",
    formatStoriesReviewSummary(prd),
  ].join("\n"), "info")

  const confirmed = await ctx.ui.confirm(
    "Ralph Setup",
    [
      formatStoriesReviewSummary(prd),
      "",
      "Accept these stories and continue to execution setup?",
    ].join("\n"),
    { signal: ctx.signal },
  )
  if (!confirmed) {
    ctx.ui.notify("Cancelled. prd.json was created but the autonomous loop was not started.", "warning")
    return true
  }

  ctx.ui.notify([
    "Step 5/5: Starting autonomous loop",
    "",
    formatStatus(prd),
    "",
    `Starting autonomous loop — ${prd.userStories.length} stories.`,
  ].join("\n"), "info")

  await maybeOfferInitialPush(ctx, cwd)
  await startLoop(ctx, paths, prd.userStories.length)
  return true
}

async function handleViewTaskHistory(
  ctx: ExtensionCommandContext,
): Promise<boolean> {
  const cwd = ctx.cwd
  const taskDirs = listTaskDirs(cwd)

  if (taskDirs.length === 0) {
    ctx.ui.notify("没有找到 Ralph 任务记录。", "info")
    return false
  }

  while (true) {
    // Build labels from task directories
    const labels: string[] = taskDirs.map((dir) => {
      const dirName = getTaskDirName(dir)
      const slug = getTaskSlug(dirName)
      const prd = readJsonFile(join(dir, "prd.json")) as PrdJson | null
      const task = readJsonFile(join(dir, "task.json")) as Record<string, unknown> | null

      if (prd?.userStories && Array.isArray(prd.userStories)) {
        const done = prd.userStories.filter((s) => s.passes).length
        const total = prd.userStories.length
        const status = done === total ? "✅" : "⏳"
        return `${status} ${dirName}  ${done}/${total}  ${prd.description}`
      }
      if (task) {
        return `📝 ${dirName}  draft  ${(task.featureDescription as string)?.slice(0, 50) || ""}`
      }
      return `❓ ${dirName}`
    })

    const choice = await ctx.ui.select("Ralph 任务历史", [...labels, "返回"], { signal: ctx.signal })
    if (!choice || choice === "返回") return false

    const index = labels.indexOf(choice)
    if (index === -1) return false
    const selectedDir = taskDirs[index]
    const selectedPaths = makeTaskPaths(cwd, getTaskDirName(selectedDir))
    const prd = readJsonFile(selectedPaths.prdJson) as PrdJson | null
    const task = readJsonFile(selectedPaths.taskJson) as Record<string, unknown> | null

    while (true) {
      const actions: string[] = ["查看摘要", "查看进度日志"]
      if (prd?.userStories && Array.isArray(prd.userStories) && !allStoriesComplete(prd)) {
        actions.push("设为当前任务")
      }
      actions.push("返回")

      const action = await ctx.ui.select(`${getTaskDirName(selectedDir)}`, actions, { signal: ctx.signal })
      if (!action || action === "返回") break

      if (action === "查看摘要") {
        if (prd?.userStories && Array.isArray(prd.userStories)) {
          ctx.ui.notify(formatStatus(prd), "info")
        } else if (task) {
          ctx.ui.notify([
            `Feature: ${task.featureDescription}`,
            `Understanding: ${task.understanding}`,
          ].join("\n"), "info")
        } else {
          ctx.ui.notify("No task data found in this directory.", "warning")
        }
        continue
      }

      if (action === "查看进度日志") {
        ctx.ui.notify([
          `ralph/${getTaskDirName(selectedDir)}/progress.txt`,
          "",
          getProgressTail(selectedPaths.progress),
        ].join("\n"), "info")
        continue
      }

      if (action === "设为当前任务") {
        // Just return true — the caller will re-scan and find this as active
        ctx.ui.notify(`已选择 ralph/${getTaskDirName(selectedDir)}/ 为当前任务。`, "info")
        return true
      }
    }
  }
}

// ============================================================================
// Autonomous loop
// ============================================================================

function formatCompletionSummary(prd: PrdJson, iterations: number, progressPath: string, elapsed: number): string {
  const done = prd.userStories.filter((s) => s.passes).length
  const total = prd.userStories.length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const barWidth = 20
  const filled = Math.round((pct / 100) * barWidth)
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled)

  const minutes = Math.floor(elapsed / 60000)
  const seconds = Math.floor((elapsed % 60000) / 1000)
  const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`

  const lines = [
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "🎉 Ralph 完成！",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    `项目: ${prd.project}`,
    `分支: ${prd.branchName}`,
    `功能: ${prd.description}`,
    "",
    `进度: ${done}/${total} stories [${bar}] ${pct}%`,
    `迭代: ${iterations} 轮`,
    `耗时: ${timeStr}`,
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "📋 故事完成清单",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    ...prd.userStories.map((s) => {
      const icon = s.passes ? "✅" : "❌"
      return `  ${icon} ${s.id} — ${s.title}`
    }),
  ]

  // Add progress log tail
  if (existsSync(progressPath)) {
    const progressContent = readFileSync(progressPath, "utf-8").trim()
    if (progressContent) {
      const progressLines = progressContent.split("\n")
      // Get last 30 lines
      const tail = progressLines.slice(Math.max(0, progressLines.length - 30)).join("\n")
      lines.push(
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "📝 工作日志（最后 30 行）",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "",
        tail,
      )
    }
  }

  lines.push(
    "",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  )

  return lines.join("\n")
}

async function startLoop(
  ctx: ExtensionCommandContext,
  paths: TaskPaths,
  maxIterations: number,
): Promise<void> {
  const cwd = ctx.cwd
  const totalStartedAt = Date.now()

  if (!existsSync(paths.progress)) {
    writeFileSync(paths.progress, `# Ralph Progress Log\nStarted: ${formatTimestamp()}\n---\n`, "utf-8")
  }

  const prd = readJsonFile(paths.prdJson) as PrdJson | null
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
    const currentPrd = readJsonFile(paths.prdJson) as PrdJson | null
    if (!currentPrd) {
      ctx.ui.notify(`Iteration ${i}: prd.json disappeared, stopping.`, "error")
      return
    }

    const nextStory = findNextStory(currentPrd)
    if (!nextStory || allStoriesComplete(currentPrd)) {
      const elapsed = Date.now() - totalStartedAt
      ctx.ui.notify(formatCompletionSummary(currentPrd, i - 1, paths.progress, elapsed), "info")
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
      `After implementation, update ${paths.prdJson} to set passes: true for this story,`,
      `then append your progress to ${paths.progress}.`,
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
      const finalPrd = readJsonFile(paths.prdJson) as PrdJson | null
      if (finalPrd && allStoriesComplete(finalPrd)) {
        const elapsed = Date.now() - totalStartedAt
        ctx.ui.notify(formatCompletionSummary(finalPrd, i, paths.progress, elapsed), "info")
        return
      }
    }

    if (i < maxIterations) {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  const finalPrd = readJsonFile(paths.prdJson) as PrdJson | null
  if (finalPrd) {
    const elapsed = Date.now() - totalStartedAt
    ctx.ui.notify(formatCompletionSummary(finalPrd, maxIterations, paths.progress, elapsed), "warning")
  } else {
    ctx.ui.notify(`Ralph reached max iterations (${maxIterations}). prd.json not found.`, "error")
  }
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
  })

  // Auto-install skills on first load
  ensureSkillsInstalled()

  // ── /ralph ──────────────────────────────────────────────────────────
  pi.registerCommand("ralph", {
    description: "Ralph autonomous agent. Run /ralph to enter the interactive workflow.",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd
      const input = args.trim()

      ctx.ui.notify(`pi-ralph v${RALPH_PLUGIN_VERSION}`, "info")

      if (input) {
        ctx.ui.notify("`/ralph` no longer accepts parameters. Run `/ralph` and follow the prompts.", "warning")
        return
      }

      // Backward-compat: migrate old-style files if they exist
      migrateLegacyTask(cwd)

      while (true) {
        // Scan ralph/ directory for active tasks
        const activePaths = findActiveTaskDir(cwd)
        const activePrd = activePaths
          ? readJsonFile(activePaths.prdJson) as PrdJson | null
          : null
        const validActivePrd = activePrd?.userStories && Array.isArray(activePrd.userStories)
          ? activePrd
          : null

        // Scan for draft tasks
        const draftPaths = findDraftTaskDir(cwd)
        const draftState = draftPaths
          ? readDraftStateFromTask(draftPaths)
          : null

        // Scan for latest completed task (for congratulatory display)
        const completedTask = !validActivePrd ? findLatestCompletedTask(cwd) : null

        const allTaskDirs = listTaskDirs(cwd)

        ctx.ui.notify(formatHomeSummary(
          validActivePrd,
          activePaths ? getTaskDirName(activePaths.taskDir) : null,
          draftState,
          draftPaths ? getTaskDirName(draftPaths.taskDir) : null,
          completedTask?.prd ?? null,
          completedTask ? getTaskDirName(completedTask.paths.taskDir) : null,
          allTaskDirs.length,
        ), "info")

        const menuOptions: string[] = []
        if (validActivePrd && activePaths && getCurrentTaskSummary(validActivePrd).storiesRemaining > 0) {
          menuOptions.push("Continue current task")
        }
        if (draftState && draftPaths) {
          menuOptions.push("Continue PRD draft")
        }
        menuOptions.push("Start new task")
        if (allTaskDirs.length > 0) {
          menuOptions.push("View history")
        }
        menuOptions.push("Exit")

        const choice = await ctx.ui.select("Ralph", menuOptions, { signal: ctx.signal })
        if (!choice || choice === "Exit") return

        if (choice === "Continue current task" && validActivePrd && activePaths) {
          if (await handleResumeCurrentTask(ctx, activePaths, validActivePrd)) {
            return
          }
          continue
        }

        if (choice === "Continue PRD draft" && draftState && draftPaths) {
          if (await handleContinueDraft(ctx, draftPaths, draftState)) {
            return
          }
          continue
        }

        if (choice === "Start new task") {
          if (await handleStartNewTask(ctx, activePaths, validActivePrd, draftPaths, draftState)) {
            return
          }
          continue
        }

        if (choice === "View history") {
          if (await handleViewTaskHistory(ctx)) {
            // User selected a task to resume — re-scan on next iteration
            continue
          }
          continue
        }
      }
    },
  })
}

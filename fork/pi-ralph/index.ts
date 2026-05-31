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
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, readdirSync, unlinkSync } from "node:fs"
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

type HistoryStatus = "completed" | "archived"

interface HistoryEntry {
  id: string
  archiveDir: string
  project: string
  branchName: string
  description: string
  storiesCompleted: number
  storiesTotal: number
  status: HistoryStatus
  reason: string
  createdAt: string
  updatedAt: string
}

interface HistoryIndex {
  version: 1
  entries: HistoryEntry[]
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
  version: 1
  featureDescription: string
  understanding: string
  prdPath: string
  questionAnswers: DraftAnswer[]
  createdAt: string
  updatedAt: string
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

    // Truncate by visible width (CJK chars = 2 cols, ANSI codes = 0 cols)
    const truncateToWidth = (str: string, maxWidth: number): string => {
      let w = 0
      let i = 0
      while (i < str.length && w < maxWidth) {
        // Skip ANSI escape sequences (0 width)
        if (str[i] === "\x1b") {
          const end = str.indexOf("m", i)
          if (end !== -1) { i = end + 1; continue }
        }
        const cp = str.codePointAt(i)!
        // CJK fullwidth: 2 columns
        const charW = (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
          (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || // CJK ... Yi
          (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
          (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
          (cp >= 0xfe10 && cp <= 0xfe6f) || // Fullwidth Forms
          (cp >= 0xff01 && cp <= 0xff60) || // Fullwidth Latin
          (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth Signs
          (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Extension B+
          (cp >= 0x30000 && cp <= 0x3fffd) ? 2 : 1
        if (w + charW > maxWidth) break
        w += charW
        i += cp > 0xffff ? 2 : 1
      }
      return str.slice(0, i)
    }

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

function formatArchiveDirTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")
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

function sanitizeArchiveSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/^ralph\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "task"
}

function getArchiveRoot(cwd: string): string {
  return join(cwd, "archive")
}

function getHistoryIndexPath(cwd: string): string {
  return join(getArchiveRoot(cwd), "history.json")
}

function readHistoryIndex(cwd: string): HistoryIndex {
  const parsed = readJsonFile(getHistoryIndexPath(cwd))
  if (!parsed || typeof parsed !== "object" || !("entries" in parsed) || !Array.isArray(parsed.entries)) {
    return { version: 1, entries: [] }
  }
  return { version: 1, entries: parsed.entries as HistoryEntry[] }
}

function writeHistoryEntries(cwd: string, entries: HistoryEntry[]): void {
  mkdirSync(getArchiveRoot(cwd), { recursive: true })
  writeFileSync(
    getHistoryIndexPath(cwd),
    `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
    "utf-8",
  )
}

function parseArchiveTimestamp(dirName: string): string | undefined {
  const compactMatch = dirName.match(/^(\d{8})-(\d{6})/)
  if (compactMatch) {
    const [, datePart, timePart] = compactMatch
    return [
      `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`,
      `${timePart.slice(0, 2)}:${timePart.slice(2, 4)}:${timePart.slice(4, 6)}`,
    ].join(" ")
  }

  const dateMatch = dirName.match(/^(\d{4}-\d{2}-\d{2})/)
  if (dateMatch) {
    return `${dateMatch[1]} 00:00:00`
  }

  return undefined
}

function createHistoryEntry(prd: PrdJson, archiveDir: string, timestamp: string, reason: string): HistoryEntry {
  const summary = getCurrentTaskSummary(prd)
  return {
    id: archiveDir,
    archiveDir,
    project: prd.project,
    branchName: prd.branchName,
    description: prd.description,
    storiesCompleted: summary.storiesCompleted,
    storiesTotal: summary.storiesTotal,
    status: summary.storiesRemaining === 0 ? "completed" : "archived",
    reason,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function discoverArchiveEntries(cwd: string): HistoryEntry[] {
  const archiveRoot = getArchiveRoot(cwd)
  if (!existsSync(archiveRoot)) return []

  const discovered: HistoryEntry[] = []
  for (const entry of readdirSync(archiveRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const archiveDir = entry.name
    const archivePrdPath = join(archiveRoot, archiveDir, "prd.json")
    const prd = readJsonFile(archivePrdPath) as PrdJson | null
    if (!prd?.userStories || !Array.isArray(prd.userStories)) continue
    const timestamp = parseArchiveTimestamp(archiveDir) ?? formatTimestamp()
    discovered.push(createHistoryEntry(prd, archiveDir, timestamp, "legacy archive"))
  }
  return discovered
}

function getHistoryEntries(cwd: string): HistoryEntry[] {
  const storedEntries = readHistoryIndex(cwd).entries
  const entriesById = new Map<string, HistoryEntry>()
  for (const entry of storedEntries) {
    entriesById.set(entry.id, entry)
  }
  for (const entry of discoverArchiveEntries(cwd)) {
    if (!entriesById.has(entry.id)) {
      entriesById.set(entry.id, entry)
    }
  }

  const entries = [...entriesById.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const storedIds = storedEntries.map((entry) => entry.id).join("|")
  const entryIds = entries.map((entry) => entry.id).join("|")
  if (storedEntries.length !== entries.length || storedIds !== entryIds) {
    writeHistoryEntries(cwd, entries)
  }
  return entries
}

function archiveCurrentRun(cwd: string, prdPath: string, progressPath: string, reason: string): HistoryEntry | null {
  const prd = readJsonFile(prdPath) as PrdJson | null
  if (!prd?.userStories || !Array.isArray(prd.userStories)) return null

  const archiveRoot = getArchiveRoot(cwd)
  mkdirSync(archiveRoot, { recursive: true })

  const archiveBaseName = `${formatArchiveDirTimestamp()}-${sanitizeArchiveSlug(prd.branchName || prd.project)}`
  let archiveDir = archiveBaseName
  let suffix = 2
  while (existsSync(join(archiveRoot, archiveDir))) {
    archiveDir = `${archiveBaseName}-${suffix}`
    suffix += 1
  }

  const archivePath = join(archiveRoot, archiveDir)
  mkdirSync(archivePath, { recursive: true })
  copyFileSync(prdPath, join(archivePath, "prd.json"))
  if (existsSync(progressPath)) {
    copyFileSync(progressPath, join(archivePath, "progress.txt"))
  }

  const timestamp = formatTimestamp()
  const entry = createHistoryEntry(prd, archiveDir, timestamp, reason)
  const entries = [entry, ...getHistoryEntries(cwd).filter((existing) => existing.id !== entry.id)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  writeHistoryEntries(cwd, entries)
  return entry
}

function getHistoryPrdPath(cwd: string, entry: HistoryEntry): string {
  return join(getArchiveRoot(cwd), entry.archiveDir, "prd.json")
}

function getHistoryProgressPath(cwd: string, entry: HistoryEntry): string {
  return join(getArchiveRoot(cwd), entry.archiveDir, "progress.txt")
}

function getDraftStatePath(cwd: string): string {
  return join(cwd, ".ralph-draft.json")
}

function readDraftState(cwd: string): DraftState | null {
  const parsed = readJsonFile(getDraftStatePath(cwd))
  if (!parsed || typeof parsed !== "object") return null
  if (!("prdPath" in parsed) || typeof parsed.prdPath !== "string") return null
  if (!("featureDescription" in parsed) || typeof parsed.featureDescription !== "string") return null
  if (!("understanding" in parsed) || typeof parsed.understanding !== "string") return null
  if (!("questionAnswers" in parsed) || !Array.isArray(parsed.questionAnswers)) return null

  return {
    version: 1,
    featureDescription: parsed.featureDescription,
    understanding: parsed.understanding,
    prdPath: parsed.prdPath,
    questionAnswers: parsed.questionAnswers as DraftAnswer[],
    createdAt: "createdAt" in parsed && typeof parsed.createdAt === "string" ? parsed.createdAt : formatTimestamp(),
    updatedAt: "updatedAt" in parsed && typeof parsed.updatedAt === "string" ? parsed.updatedAt : formatTimestamp(),
  }
}

function writeDraftState(cwd: string, draft: DraftState): void {
  writeFileSync(getDraftStatePath(cwd), `${JSON.stringify(draft, null, 2)}\n`, "utf-8")
}

function clearDraftState(cwd: string): void {
  const statePath = getDraftStatePath(cwd)
  if (existsSync(statePath)) {
    unlinkSync(statePath)
  }
}

function resolveDraftPrdPath(cwd: string, prdPath: string): string {
  return prdPath.startsWith("/") ? prdPath : join(cwd, prdPath)
}

function clearCurrentTaskFiles(prdPath: string, progressPath: string): void {
  if (existsSync(prdPath)) unlinkSync(prdPath)
  if (existsSync(progressPath)) unlinkSync(progressPath)
}

function getProgressTail(progressPath: string, maxLines = 20): string {
  if (!existsSync(progressPath)) return "No progress log was archived."
  const lines = readFileSync(progressPath, "utf-8").split("\n")
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n").trim() || "No progress log was archived."
}

function formatHistoryStatus(status: HistoryStatus): string {
  return status === "completed" ? "completed" : "archived"
}

function formatHistoryOption(entry: HistoryEntry): string {
  return [
    entry.updatedAt,
    `${entry.storiesCompleted}/${entry.storiesTotal}`,
    formatHistoryStatus(entry.status),
    entry.description,
  ].join(" | ")
}

function formatDraftSummary(draft: DraftState): string {
  const lines = [
    "Draft PRD awaiting review",
    `Feature:   ${draft.featureDescription}`,
    `Draft:     ${draft.prdPath}`,
    `Updated:   ${draft.updatedAt}`,
    "",
    "Ralph's understanding:",
    draft.understanding,
  ]

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

function formatHomeSummary(currentPrd: PrdJson | null, draft: DraftState | null, historyEntries: HistoryEntry[]): string {
  const lines = [
    `Ralph Home (pi-ralph v${RALPH_PLUGIN_VERSION})`,
    "",
  ]

  if (currentPrd?.userStories && Array.isArray(currentPrd.userStories)) {
    const summary = getCurrentTaskSummary(currentPrd)
    lines.push(`Current:   ${summary.prd.description}`)
    lines.push(`Branch:    ${summary.prd.branchName}`)
    lines.push(`Progress:  ${summary.storiesCompleted}/${summary.storiesTotal} stories complete`)
    if (summary.nextStory) {
      lines.push(`Next:      ${summary.nextStory.id} — ${summary.nextStory.title}`)
    } else {
      lines.push("Next:      all stories complete")
    }
  } else {
    lines.push("Current:   no active Ralph task")
  }

  if (draft) {
    lines.push(`Draft:     ${draft.prdPath}`)
    lines.push(`Draft At:  ${draft.updatedAt}`)
  }

  lines.push(`History:   ${historyEntries.length} archived runs`)
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

function formatHistorySummary(entry: HistoryEntry, prd: PrdJson | null): string {
  const lines = [
    `Archive:   archive/${entry.archiveDir}`,
    `Project:   ${entry.project}`,
    `Branch:    ${entry.branchName}`,
    `Feature:   ${entry.description}`,
    `Status:    ${formatHistoryStatus(entry.status)}`,
    `Progress:  ${entry.storiesCompleted}/${entry.storiesTotal} stories complete`,
    `Archived:  ${entry.updatedAt}`,
    `Reason:    ${entry.reason}`,
  ]

  if (prd?.userStories && Array.isArray(prd.userStories)) {
    const nextStory = findNextStory(prd)
    lines.push("")
    if (nextStory) {
      lines.push(`Next story at restore time: ${nextStory.id} — ${nextStory.title}`)
    } else {
      lines.push("Next story at restore time: none")
    }
  }

  return lines.join("\n")
}

function formatHistoryComparison(currentPrd: PrdJson, historyEntry: HistoryEntry, historyPrd: PrdJson | null): string {
  const current = getCurrentTaskSummary(currentPrd)
  const archived = historyPrd ? getCurrentTaskSummary(historyPrd) : null

  return [
    "Current vs archived task",
    "",
    `Current feature:  ${current.prd.description}`,
    `Archive feature:  ${historyEntry.description}`,
    `Current branch:   ${current.prd.branchName}`,
    `Archive branch:   ${historyEntry.branchName}`,
    `Current stories:  ${current.storiesCompleted}/${current.storiesTotal}`,
    `Archive stories:  ${historyEntry.storiesCompleted}/${historyEntry.storiesTotal}`,
    `Current next:     ${current.nextStory ? `${current.nextStory.id} — ${current.nextStory.title}` : "none"}`,
    `Archive next:     ${archived?.nextStory ? `${archived.nextStory.id} — ${archived.nextStory.title}` : "none"}`,
    `Archive updated:  ${historyEntry.updatedAt}`,
  ].join("\n")
}

// ============================================================================
// Archive
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
      "Describe the feature Ralph should plan and implement",
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
    .replace(/<promise>COMPLETE<\/promise>/g, "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()

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
  const maxLabelLen = Math.max(20, termWidth - prefix.length - suffix.length)
  const truncatedLabel = label.length > maxLabelLen ? label.slice(0, maxLabelLen - 1) + "…" : label
  const text = `${prefix}${truncatedLabel}${suffix}`
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

  return { data, rawOutput }
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
  prdPath: string,
  progressPath: string,
  prd: PrdJson,
): Promise<boolean> {
  if (!(await ensureGitRepo(ctx))) return false

  showStatus(ctx, prd)

  const shouldResume = await ctx.ui.confirm(
    "Resume Current Task?",
    [
      formatResumeSummary(prd),
      "",
      "Continue this Ralph task now?",
    ].join("\n"),
    { signal: ctx.signal },
  )
  if (!shouldResume) return false

  await maybeOfferInitialPush(ctx, ctx.cwd)
  await startLoop(ctx, prdPath, progressPath, prd.userStories.length)
  return true
}

async function handleStartNewTask(
  ctx: ExtensionCommandContext,
  prdPath: string,
  progressPath: string,
  existingPrd: PrdJson | null,
  existingDraft: DraftState | null,
): Promise<boolean> {
  const cwd = ctx.cwd

  // Ensure we're in a git repo — ralph depends on git for tracking changes
  if (!(await ensureGitRepo(ctx))) return false

  let shouldArchiveCurrentTask = false

  // Build a single combined confirmation if there's existing work to replace
  const hasDraft = !!existingDraft
  const hasPrd = !!(existingPrd?.userStories && Array.isArray(existingPrd.userStories))

  if (hasDraft || hasPrd) {
    const lines: string[] = ["Ralph 同时只能执行一个任务。"]
    if (hasPrd) {
      const summary = getCurrentTaskSummary(existingPrd!)
      lines.push(
        "",
        `当前任务: ${existingPrd!.description}`,
        `分支: ${existingPrd!.branchName}`,
        `进度: ${summary.storiesCompleted}/${summary.storiesTotal} stories`,
      )
    }
    if (hasDraft) {
      lines.push(`草稿: ${existingDraft!.prdPath}`)
    }
    lines.push(
      "",
      "开始新任务后，当前任务将被归档（可查看但不可继续）。",
      "如需恢复旧任务的工作，需基于归档记录创建新任务。",
    )

    const confirmed = await ctx.ui.confirm("归档并开始新任务？", lines.join("\n"), { signal: ctx.signal })
    if (!confirmed) {
      ctx.ui.notify("已取消。当前任务保持不变。", "warning")
      return false
    }

    shouldArchiveCurrentTask = hasPrd
  }

  const featureDescription = await promptFeatureDescription(ctx)
  if (featureDescription === undefined) {
    ctx.ui.notify("Cancelled before creating a new Ralph task.", "warning")
    return false
  }

  ctx.ui.notify([
    "📋 Step 1/4: 需求已记录",
    "",
    featureDescription,
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

  const draftAbsolutePath = resolveDraftPrdPath(cwd, draftResult.data.prdPath)
  if (!existsSync(draftAbsolutePath)) {
    ctx.ui.notify([
      "❌ PRD 生成失败 — 文件未找到",
      "",
      `Expected: ${draftResult.data.prdPath}`,
    ].join("\n"), "error")
    return false
  }

  ctx.ui.notify(`✅ Step 4/4: PRD 文档已生成 → ${draftResult.data.prdPath}`, "warning")

  if (shouldArchiveCurrentTask) {
    const archived = archiveCurrentRun(cwd, prdPath, progressPath, "replaced by a new task draft")
    if (archived) {
      ctx.ui.notify(`Archived current task to archive/${archived.archiveDir}.`, "info")
    }
    clearCurrentTaskFiles(prdPath, progressPath)
  }

  const now = formatTimestamp()
  const draftState: DraftState = {
    version: 1,
    featureDescription,
    understanding,
    prdPath: draftResult.data.prdPath,
    questionAnswers: allAnswers,
    createdAt: existingDraft?.createdAt ?? now,
    updatedAt: now,
  }
  writeDraftState(cwd, draftState)

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

    const convertStatus = startWorkerStatus(ctx, `Convert ${draftResult.data.prdPath}`, Date.now())
    const convertWorker = await runWorker(cwd, `PRD file: ${draftResult.data.prdPath}`, converterSkillPath, ctx.signal, convertStatus.update)
    convertStatus.finish(convertWorker.exitCode === 0 && existsSync(prdPath) ? "completed" : "failed")

    // Check if conversion succeeded
    if (convertWorker.exitCode === 0 && existsSync(prdPath)) {
      prd = readJsonFile(prdPath) as PrdJson | null
      if (prd?.userStories && Array.isArray(prd.userStories)) {
        break // Success!
      }
    }

    // Conversion failed — AI attempts to fix
    if (attempt < MAX_CONVERT_ATTEMPTS) {
      const workerOutput = getFinalOutput(convertWorker.messages)
      const prdContent = readFileSync(draftResult.data.prdPath, "utf-8").slice(0, 3000)

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
        `## Error: exitCode=${convertWorker.exitCode}, prd.json exists=${existsSync(prdPath)}`,
        "",
        "## Your task:",
        "1. Read the PRD markdown at: " + draftResult.data.prdPath,
        "2. Generate the correct prd.json in the current directory",
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
      if (existsSync(prdPath)) {
        prd = readJsonFile(prdPath) as PrdJson | null
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
      `PRD 草稿: ${draftResult.data.prdPath}`,
      "你可以手动编辑 PRD 后通过 /ralph → Continue PRD draft 继续",
    ].join("\n"), "error")
    return false
  }

  clearDraftState(cwd)

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

  // [debug] trace confirm behavior
  const _sigAborted = ctx.signal?.aborted ?? "no-signal"
  ctx.ui.notify(`[debug] signal.aborted=${_sigAborted}, about to call confirm`, "warning")

  const confirmed = await ctx.ui.select(
    "确认开始执行？\n\n" + summaryLines.join("\n"),
    ["✅ 开始执行", "❌ 取消"],
    { signal: ctx.signal },
  )

  ctx.ui.notify(`[debug] select returned: ${String(confirmed)}`, "warning")

  if (confirmed !== "✅ 开始执行") {
    ctx.ui.notify([
      "已取消。PRD 已保存，可通过 /ralph 继续。",
      `文件: ${prdPath}`,
    ].join("\n"), "warning")
    return true
  }

  // ── Start execution ────────────────────────────────────────────────
  await maybeOfferInitialPush(ctx, cwd)
  await startLoop(ctx, prdPath, progressPath, storyCount)
  return true
}

async function handleContinueDraft(
  ctx: ExtensionCommandContext,
  prdPath: string,
  progressPath: string,
  draft: DraftState,
): Promise<boolean> {
  if (!(await ensureGitRepo(ctx))) return false

  const cwd = ctx.cwd
  const draftAbsolutePath = resolveDraftPrdPath(cwd, draft.prdPath)

  if (!existsSync(draftAbsolutePath)) {
    const clearStaleDraft = await ctx.ui.confirm(
      "Draft File Missing?",
      [
        `Draft file was not found: ${draft.prdPath}`,
        "",
        "Clear the saved draft state so you can start over?",
      ].join("\n"),
      { signal: ctx.signal },
    )
    if (clearStaleDraft) {
      clearDraftState(cwd)
      ctx.ui.notify("Cleared the missing PRD draft state.", "warning")
      return false
    }
    return true
  }

  ctx.ui.notify(formatDraftSummary(draft), "info")

  const readyToConvert = await ctx.ui.confirm(
    "Continue PRD Draft?",
    [
      formatDraftSummary(draft),
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
      `Draft file: ${draft.prdPath}`,
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
  const status = startWorkerStatus(ctx, `Convert ${draft.prdPath}`, totalStartedAt)
  const worker = await runWorker(cwd, `PRD file: ${draft.prdPath}`, converterSkillPath, ctx.signal, status.update)
  status.finish(worker.exitCode === 0 && existsSync(prdPath) ? "completed" : "failed")

  if (worker.exitCode !== 0 || !existsSync(prdPath)) {
    const output = getFinalOutput(worker.messages)
    ctx.ui.notify([
      "Failed to convert the reviewed PRD draft into prd.json.",
      "",
      "Worker output:",
      output.slice(-800),
    ].join("\n"), "error")
    return false
  }

  const prd = readJsonFile(prdPath) as PrdJson | null
  if (!prd?.userStories || !Array.isArray(prd.userStories)) {
    ctx.ui.notify("prd.json was created but is invalid.", "error")
    return false
  }

  clearDraftState(cwd)
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
  await startLoop(ctx, prdPath, progressPath, prd.userStories.length)
  return true
}

async function handleRestoreHistoryEntry(
  ctx: ExtensionCommandContext,
  entry: HistoryEntry,
  prdPath: string,
  progressPath: string,
  currentPrd: PrdJson | null,
): Promise<boolean> {
  const cwd = ctx.cwd

  if (currentPrd?.userStories && Array.isArray(currentPrd.userStories)) {
    const summary = getCurrentTaskSummary(currentPrd)
    const shouldArchiveCurrent = await ctx.ui.confirm(
      "Restore Archived Task?",
      [
        `Current task: ${currentPrd.description}`,
        `Progress: ${summary.storiesCompleted}/${summary.storiesTotal} stories complete`,
        "",
        `Archive the current task, then restore archive/${entry.archiveDir}?`,
      ].join("\n"),
      { signal: ctx.signal },
    )
    if (!shouldArchiveCurrent) return false

    const archivedCurrent = archiveCurrentRun(cwd, prdPath, progressPath, `replaced by restore from ${entry.archiveDir}`)
    if (archivedCurrent) {
      ctx.ui.notify(`Archived current task to archive/${archivedCurrent.archiveDir}.`, "info")
    }
  } else {
    const shouldRestore = await ctx.ui.confirm(
      "Restore Archived Task?",
      `Restore archive/${entry.archiveDir} as the current Ralph task?`,
      { signal: ctx.signal },
    )
    if (!shouldRestore) return false
  }

  copyFileSync(getHistoryPrdPath(cwd, entry), prdPath)
  const archivedProgressPath = getHistoryProgressPath(cwd, entry)
  if (existsSync(archivedProgressPath)) {
    copyFileSync(archivedProgressPath, progressPath)
  } else {
    writeFileSync(progressPath, `# Ralph Progress Log\nStarted: ${formatTimestamp()}\n---\n`, "utf-8")
  }

  ctx.ui.notify(`Restored archive/${entry.archiveDir} as the current Ralph task.`, "info")

  const restoredPrd = readJsonFile(prdPath) as PrdJson | null
  if (!restoredPrd?.userStories || !Array.isArray(restoredPrd.userStories)) return true

  const resumeNow = await ctx.ui.confirm(
    "Resume Restored Task?",
    [
      formatResumeSummary(restoredPrd),
      "",
      "Resume the restored task now?",
    ].join("\n"),
    { signal: ctx.signal },
  )
  if (!resumeNow) return true

  await maybeOfferInitialPush(ctx, cwd)
  await startLoop(ctx, prdPath, progressPath, restoredPrd.userStories.length)
  return true
}

async function handleHistoryMenu(
  ctx: ExtensionCommandContext,
  prdPath: string,
  progressPath: string,
  currentPrd: PrdJson | null,
): Promise<boolean> {
  const cwd = ctx.cwd

  while (true) {
    const historyEntries = getHistoryEntries(cwd)
    if (historyEntries.length === 0) {
      ctx.ui.notify("No archived Ralph tasks were found in archive/.", "info")
      return false
    }

    const labels = historyEntries.map(formatHistoryOption)
    const choice = await ctx.ui.select("Ralph History", [...labels, "Back"], { signal: ctx.signal })
    if (!choice || choice === "Back") return false

    const index = labels.indexOf(choice)
    if (index === -1) return false
    const entry = historyEntries[index]
    const historyPrd = readJsonFile(getHistoryPrdPath(cwd, entry)) as PrdJson | null

    while (true) {
      const actions = [
        "View summary",
        "View progress log",
        "Compare with current task",
        "Restore as current task",
        "Back",
      ]
      const action = await ctx.ui.select(`History: ${entry.description}`, actions, { signal: ctx.signal })
      if (!action || action === "Back") break

      if (action === "View summary") {
        ctx.ui.notify(formatHistorySummary(entry, historyPrd), "info")
        continue
      }

      if (action === "View progress log") {
        ctx.ui.notify([
          `archive/${entry.archiveDir}/progress.txt`,
          "",
          getProgressTail(getHistoryProgressPath(cwd, entry)),
        ].join("\n"), "info")
        continue
      }

      if (action === "Compare with current task") {
        if (!currentPrd?.userStories || !Array.isArray(currentPrd.userStories)) {
          ctx.ui.notify("No current task is active, so there is nothing to compare.", "warning")
          continue
        }
        ctx.ui.notify(formatHistoryComparison(currentPrd, entry, historyPrd), "info")
        continue
      }

      if (action === "Restore as current task") {
        return await handleRestoreHistoryEntry(ctx, entry, prdPath, progressPath, currentPrd)
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
  prdPath: string,
  progressPath: string,
  maxIterations: number,
): Promise<void> {
  const cwd = ctx.cwd
  const totalStartedAt = Date.now()

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
      const elapsed = Date.now() - totalStartedAt
      ctx.ui.notify(formatCompletionSummary(currentPrd, i - 1, progressPath, elapsed), "info")
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
        const elapsed = Date.now() - totalStartedAt
        ctx.ui.notify(formatCompletionSummary(finalPrd, i, progressPath, elapsed), "info")
        return
      }
    }

    if (i < maxIterations) {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  const finalPrd = readJsonFile(prdPath) as PrdJson | null
  if (finalPrd) {
    const elapsed = Date.now() - totalStartedAt
    ctx.ui.notify(formatCompletionSummary(finalPrd, maxIterations, progressPath, elapsed), "warning")
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
    ctx.ui.setEditorComponent(undefined)
  })

  // Auto-install skills on first load
  ensureSkillsInstalled()

  // ── /ralph ──────────────────────────────────────────────────────────
  pi.registerCommand("ralph", {
    description: "Ralph autonomous agent. Run /ralph to enter the interactive workflow.",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd
      const prdPath = join(cwd, "prd.json")
      const progressPath = join(cwd, "progress.txt")
      const input = args.trim()

      ctx.ui.notify(`pi-ralph v${RALPH_PLUGIN_VERSION}`, "info")

      if (input) {
        ctx.ui.notify("`/ralph` no longer accepts parameters. Run `/ralph` and follow the prompts.", "warning")
        return
      }

      while (true) {
        const currentPrd = readJsonFile(prdPath) as PrdJson | null
        const validCurrentPrd = currentPrd?.userStories && Array.isArray(currentPrd.userStories)
          ? currentPrd
          : null
        const draftState = readDraftState(cwd)
        const historyEntries = getHistoryEntries(cwd)

        if (currentPrd && !validCurrentPrd) {
          ctx.ui.notify("Current prd.json exists but is invalid. Start a new task or restore from history.", "warning")
        }

        ctx.ui.notify(formatHomeSummary(validCurrentPrd, draftState, historyEntries), "info")

        const menuOptions: string[] = []
        if (validCurrentPrd && getCurrentTaskSummary(validCurrentPrd).storiesRemaining > 0) {
          menuOptions.push("Continue current task")
        }
        if (draftState) {
          menuOptions.push("Continue PRD draft")
        }
        menuOptions.push("Start new task")
        menuOptions.push("View history")
        menuOptions.push("Exit")

        const choice = await ctx.ui.select("Ralph", menuOptions, { signal: ctx.signal })
        if (!choice || choice === "Exit") return

        if (choice === "Continue current task" && validCurrentPrd) {
          if (await handleResumeCurrentTask(ctx, prdPath, progressPath, validCurrentPrd)) {
            return
          }
          continue
        }

        if (choice === "Continue PRD draft" && draftState) {
          if (await handleContinueDraft(ctx, prdPath, progressPath, draftState)) {
            return
          }
          continue
        }

        if (choice === "Start new task") {
          if (await handleStartNewTask(ctx, prdPath, progressPath, validCurrentPrd, draftState)) {
            return
          }
          continue
        }

        if (choice === "View history") {
          if (await handleHistoryMenu(ctx, prdPath, progressPath, validCurrentPrd)) {
            return
          }
          continue
        }
      }
    },
  })
}

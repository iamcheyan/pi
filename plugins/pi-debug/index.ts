/**
 * pi-debug - interactive autonomous debugging workflow for pi.
 *
 * Single entry point: /debug
 */

import { spawn, spawnSync } from "node:child_process"
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Message } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

type DebugStatus = "ready" | "running" | "completed" | "failed" | "cancelled" | "archived"
type DebugProfileId = "browser-extension" | "web-app" | "cli" | "api" | "electron" | "android-app" | "generic"

interface DebugQuestion {
  question: string
  options: string[]
  reason?: string
}

interface DebugAnswer {
  question: string
  answer: string
}

interface IntakeResult {
  understanding: string
  questions: DebugQuestion[]
}

interface DebugTestPlan {
  summary: string
  reproductionSteps: string[]
  verificationChecks: string[]
  commands: string[]
  temporaryFiles: string[]
  risks: string[]
}

interface DebugProfileDetection {
  id: DebugProfileId
  label: string
  confidence: "high" | "medium" | "low"
  evidence: string[]
  collector: "browser" | "command" | "adb" | "manual"
}

interface ReproductionCapture {
  profile: DebugProfileId
  eventsPath: string
  snippetPath: string
  eventCount: number
  startedAt: string
  endedAt: string
  notes: string
  fileWatcherEventsPath?: string
  fileWatcherEventCount?: number
  processWatcherEventsPath?: string
  processWatcherEventCount?: number
}

interface DebugTask {
  version: 1
  id: string
  project: string
  profile: DebugProfileDetection
  originalReport: string
  problemStatement: string
  clarifications: DebugAnswer[]
  capture?: ReproductionCapture
  testPlan: DebugTestPlan
  status: DebugStatus
  createdAt: string
  updatedAt: string
}

interface WorkerJsonResult {
  completed: boolean
  summary: string
  verification: string[]
  remainingIssues: string[]
}

interface WorkerResult {
  exitCode: number
  messages: Message[]
  stderr: string
  completed: boolean
}

interface WorkerProgress {
  stepCount: number
  lastEvent: string
}

interface HistoryEntry {
  id: string
  archiveDir: string
  problemStatement: string
  status: DebugStatus
  createdAt: string
  updatedAt: string
}

interface HistoryIndex {
  version: 1
  entries: HistoryEntry[]
}

interface PackageJsonSummary {
  name?: string
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  bin: Record<string, string>
}

const DEBUG_PLUGIN_VERSION = "20260531-000000"
const SKILLS = ["debug-detect-profile", "debug-intake", "debug-test-plan", "debug-worker", "debug-verify"] as const

type SkillName = (typeof SKILLS)[number]

function getExtensionDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

function ensureSkillsInstalled(): void {
  const skillsSourceDir = join(getExtensionDir(), "skills")
  const skillsTargetDir = join(homedir(), ".pi", "agent", "skills")
  if (!existsSync(skillsSourceDir)) return

  for (const skill of SKILLS) {
    const src = join(skillsSourceDir, skill, "SKILL.md")
    const destDir = join(skillsTargetDir, skill)
    const dest = join(destDir, "SKILL.md")
    if (!existsSync(src) || existsSync(dest)) continue

    try {
      mkdirSync(destDir, { recursive: true })
      symlinkSync(src, dest)
    } catch {
      // Best effort only. Users may already have a real skill file installed.
    }
  }
}

function readJsonFile(filePath: string): unknown | null {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"))
  } catch {
    return null
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

function formatTimestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}

function formatArchiveTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")
}

function createTaskId(): string {
  return `debug-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`
}

function getDebugRoot(cwd: string): string {
  return join(cwd, ".debug", "pi-debug")
}

function getCurrentTaskPath(cwd: string): string {
  return join(getDebugRoot(cwd), "current.json")
}

function getProgressPath(cwd: string): string {
  return join(getDebugRoot(cwd), "progress.txt")
}

function getArchiveRoot(cwd: string): string {
  return join(getDebugRoot(cwd), "history")
}

function getHistoryIndexPath(cwd: string): string {
  return join(getArchiveRoot(cwd), "history.json")
}

function readCurrentTask(cwd: string): DebugTask | null {
  const parsed = readJsonFile(getCurrentTaskPath(cwd))
  if (!parsed || typeof parsed !== "object") return null
  if (!("version" in parsed) || parsed.version !== 1) return null
  if (!("id" in parsed) || typeof parsed.id !== "string") return null
  if (!("problemStatement" in parsed) || typeof parsed.problemStatement !== "string") return null
  if (!("testPlan" in parsed) || typeof parsed.testPlan !== "object") return null
  const task = parsed as DebugTask
  return {
    ...task,
    profile: task.profile ?? detectDebugProfile(cwd),
  }
}

function writeCurrentTask(cwd: string, task: DebugTask): void {
  writeJsonFile(getCurrentTaskPath(cwd), { ...task, updatedAt: formatTimestamp() })
}

function readHistoryIndex(cwd: string): HistoryIndex {
  const parsed = readJsonFile(getHistoryIndexPath(cwd))
  if (!parsed || typeof parsed !== "object") return { version: 1, entries: [] }
  if (!("entries" in parsed) || !Array.isArray(parsed.entries)) return { version: 1, entries: [] }
  return { version: 1, entries: parsed.entries as HistoryEntry[] }
}

function writeHistoryIndex(cwd: string, entries: HistoryEntry[]): void {
  writeJsonFile(getHistoryIndexPath(cwd), { version: 1, entries })
}

function sanitizeSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "debug-task"
}

function archiveCurrentTask(cwd: string, reason: string): HistoryEntry | null {
  const task = readCurrentTask(cwd)
  if (!task) return null

  const archiveRoot = getArchiveRoot(cwd)
  mkdirSync(archiveRoot, { recursive: true })

  const baseName = `${formatArchiveTimestamp()}-${sanitizeSlug(task.problemStatement).slice(0, 48)}`
  let archiveDir = baseName
  let suffix = 2
  while (existsSync(join(archiveRoot, archiveDir))) {
    archiveDir = `${baseName}-${suffix}`
    suffix += 1
  }

  const archivePath = join(archiveRoot, archiveDir)
  mkdirSync(archivePath, { recursive: true })
  const archivedTask: DebugTask = { ...task, status: task.status === "completed" ? "completed" : "archived" }
  writeJsonFile(join(archivePath, "task.json"), archivedTask)
  if (existsSync(getProgressPath(cwd))) copyFileSync(getProgressPath(cwd), join(archivePath, "progress.txt"))

  const entry: HistoryEntry = {
    id: archiveDir,
    archiveDir,
    problemStatement: task.problemStatement,
    status: archivedTask.status,
    createdAt: task.createdAt,
    updatedAt: formatTimestamp(),
  }

  const entries = [entry, ...readHistoryIndex(cwd).entries.filter((existing) => existing.id !== entry.id)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  writeHistoryIndex(cwd, entries)

  const currentPath = getCurrentTaskPath(cwd)
  if (existsSync(currentPath)) unlinkSync(currentPath)
  return entry
}

function readPackageSummary(cwd: string): PackageJsonSummary | null {
  const parsed = readJsonFile(join(cwd, "package.json"))
  if (!parsed || typeof parsed !== "object") return null
  const name = "name" in parsed && typeof parsed.name === "string" ? parsed.name : undefined
  const scripts: Record<string, string> = {}
  const dependencies: Record<string, string> = {}
  const devDependencies: Record<string, string> = {}
  const bin: Record<string, string> = {}
  if ("scripts" in parsed && parsed.scripts && typeof parsed.scripts === "object") {
    for (const [key, value] of Object.entries(parsed.scripts)) {
      if (typeof value === "string") scripts[key] = value
    }
  }
  if ("dependencies" in parsed && parsed.dependencies && typeof parsed.dependencies === "object") {
    for (const [key, value] of Object.entries(parsed.dependencies)) {
      if (typeof value === "string") dependencies[key] = value
    }
  }
  if ("devDependencies" in parsed && parsed.devDependencies && typeof parsed.devDependencies === "object") {
    for (const [key, value] of Object.entries(parsed.devDependencies)) {
      if (typeof value === "string") devDependencies[key] = value
    }
  }
  if ("bin" in parsed) {
    if (typeof parsed.bin === "string") {
      bin[name ?? basename(cwd)] = parsed.bin
    } else if (parsed.bin && typeof parsed.bin === "object") {
      for (const [key, value] of Object.entries(parsed.bin)) {
        if (typeof value === "string") bin[key] = value
      }
    }
  }
  return { name, scripts, dependencies, devDependencies, bin }
}

function getProjectName(cwd: string): string {
  return readPackageSummary(cwd)?.name ?? basename(cwd)
}

function hasPackageName(summary: PackageJsonSummary | null, packageNames: string[]): boolean {
  if (!summary) return false
  return packageNames.some((name) => name in summary.dependencies || name in summary.devDependencies)
}

function detectDebugProfile(cwd: string): DebugProfileDetection {
  const packageSummary = readPackageSummary(cwd)
  const evidence: string[] = []

  if (existsSync(join(cwd, "manifest.json"))) {
    evidence.push("manifest.json exists")
    const manifest = readJsonFile(join(cwd, "manifest.json"))
    if (manifest && typeof manifest === "object" && "background" in manifest) {
      evidence.push("manifest.json has background configuration")
    }
    return {
      id: "browser-extension",
      label: "Browser extension",
      confidence: "high",
      evidence,
      collector: "browser",
    }
  }

  if (existsSync(join(cwd, "gradlew")) || existsSync(join(cwd, "gradlew.bat"))) {
    evidence.push("gradlew exists")
    const buildGradle = existsSync(join(cwd, "build.gradle"))
      ? readFileSync(join(cwd, "build.gradle"), "utf-8")
      : existsSync(join(cwd, "build.gradle.kts"))
        ? readFileSync(join(cwd, "build.gradle.kts"), "utf-8")
        : ""
    if (buildGradle.includes("com.android.application") || buildGradle.includes("com.android.library")) {
      evidence.push("build.gradle contains Android plugin")
    }
    if (existsSync(join(cwd, "app", "src", "main", "AndroidManifest.xml"))) {
      evidence.push("app/src/main/AndroidManifest.xml exists")
    }
    if (existsSync(join(cwd, "android"))) {
      evidence.push("android/ directory exists (possible React Native or Flutter)")
    }
    if (evidence.length >= 2) {
      return { id: "android-app", label: "Android app", confidence: "high", evidence, collector: "adb" }
    }
  }

  if (hasPackageName(packageSummary, ["electron"])) {
    evidence.push("package.json depends on electron")
    return { id: "electron", label: "Electron app", confidence: "high", evidence, collector: "browser" }
  }

  if (packageSummary && Object.keys(packageSummary.bin).length > 0) {
    evidence.push("package.json defines bin entries")
    return { id: "cli", label: "CLI tool", confidence: "high", evidence, collector: "command" }
  }

  if (hasPackageName(packageSummary, ["express", "fastify", "hono", "koa", "@nestjs/core"])) {
    evidence.push("package.json includes API/server framework dependencies")
    return { id: "api", label: "API service", confidence: "medium", evidence, collector: "command" }
  }

  if (hasPackageName(packageSummary, ["vite", "next", "react", "vue", "svelte", "@angular/core"])) {
    evidence.push("package.json includes web app framework dependencies")
    return { id: "web-app", label: "Web app", confidence: "medium", evidence, collector: "browser" }
  }

  if (packageSummary) {
    evidence.push("package.json exists")
  } else {
    evidence.push("no package.json profile signal")
  }
  return { id: "generic", label: "Generic project", confidence: "low", evidence, collector: "manual" }
}

function formatTaskSummary(task: DebugTask): string {
  const lines = [
    `Debug task: ${task.id}`,
    `Project:    ${task.project}`,
    `Profile:    ${task.profile.label} (${task.profile.confidence})`,
    `Status:     ${task.status}`,
    `Created:    ${task.createdAt}`,
    "",
    "Problem:",
    task.problemStatement,
    "",
    "Test plan:",
    task.testPlan.summary,
  ]

  if (task.testPlan.commands.length > 0) {
    lines.push("")
    lines.push("Commands:")
    for (const command of task.testPlan.commands) lines.push(`- ${command}`)
  }

  if (task.capture) {
    lines.push("")
    lines.push("Reproduction capture:")
    lines.push(`- events: ${task.capture.eventsPath}`)
    lines.push(`- count: ${task.capture.eventCount}`)
  }

  return lines.join("\n")
}

function formatTestPlan(plan: DebugTestPlan): string {
  const lines = ["Test plan", "", plan.summary, ""]
  lines.push("Reproduction:")
  for (const step of plan.reproductionSteps) lines.push(`- ${step}`)
  lines.push("")
  lines.push("Verification:")
  for (const check of plan.verificationChecks) lines.push(`- ${check}`)
  if (plan.commands.length > 0) {
    lines.push("")
    lines.push("Commands:")
    for (const command of plan.commands) lines.push(`- ${command}`)
  }
  if (plan.risks.length > 0) {
    lines.push("")
    lines.push("Risks:")
    for (const risk of plan.risks) lines.push(`- ${risk}`)
  }
  return lines.join("\n")
}

function getProfileCapabilities(profile: DebugProfileDetection): string {
  switch (profile.collector) {
    case "browser":
      return "Browser console/error/Fetch/XHR capture available"
    case "adb":
      return "ADB screenshot, logcat, and UI dump available"
    case "command":
      return "stdout/stderr process capture available"
    default:
      return "Manual reproduction required"
  }
}

function formatHomeSummary(cwd: string, currentTask: DebugTask | null, historyEntries: HistoryEntry[]): string {
  const packageSummary = readPackageSummary(cwd)
  const scripts = packageSummary ? Object.keys(packageSummary.scripts).sort().join(", ") || "none" : "no package.json"
  const profile = detectDebugProfile(cwd)
  const lines = [
    `Pi Debug Home (pi-debug v${DEBUG_PLUGIN_VERSION})`,
    "",
    `Project: ${getProjectName(cwd)}`,
    `Detected: ${profile.label} (${profile.confidence})`,
    `Capabilities: ${getProfileCapabilities(profile)}`,
    `Scripts: ${scripts}`,
    `History: ${historyEntries.length} archived debug tasks`,
  ]

  if (currentTask) {
    lines.push("")
    lines.push(`Active: ${currentTask.problemStatement}`)
    lines.push(`Status: ${currentTask.status}`)
  } else {
    lines.push("")
    lines.push("Active: no active debug task")
  }

  return lines.join("\n")
}

function formatProfileDetection(profile: DebugProfileDetection): string {
  return [
    `Detected debug profile: ${profile.label}`,
    `Confidence: ${profile.confidence}`,
    `Collector: ${profile.collector}`,
    "",
    "Evidence:",
    ...profile.evidence.map((item) => `- ${item}`),
  ].join("\n")
}

function getCaptureRoot(cwd: string): string {
  return join(getDebugRoot(cwd), "captures")
}

function createBrowserCollectorSnippet(eventUrl: string): string {
  return `(() => {
  const endpoint = ${JSON.stringify(eventUrl)};
  const send = (type, payload) => {
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type,
        payload,
        href: location.href,
        userAgent: navigator.userAgent,
        ts: new Date().toISOString()
      })
    }).catch(() => {});
  };
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      send("console." + level, args.map((arg) => {
        if (arg instanceof Error) return { name: arg.name, message: arg.message, stack: arg.stack };
        try { return JSON.parse(JSON.stringify(arg)); } catch { return String(arg); }
      }));
      original(...args);
    };
  }
  window.addEventListener("error", (event) => {
    send("window.error", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error ? { name: event.error.name, message: event.error.message, stack: event.error.stack } : undefined
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    send("window.unhandledrejection", reason instanceof Error
      ? { name: reason.name, message: reason.message, stack: reason.stack }
      : { reason: String(reason) });
  });
  const originalFetch = window.fetch?.bind(window);
  if (originalFetch) {
    window.fetch = async (...args) => {
      try {
        const response = await originalFetch(...args);
        if (!response.ok) send("fetch.not_ok", { input: String(args[0]), status: response.status, statusText: response.statusText });
        return response;
      } catch (error) {
        send("fetch.error", { input: String(args[0]), error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    };
  }
  send("collector.ready", { endpoint });
})();`
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ""
    req.on("data", (chunk: Buffer) => {
      if (body.length < 256_000) body += chunk.toString()
    })
    req.on("end", () => resolve(body))
    req.on("error", () => resolve(body))
  })
}

function writeCollectorResponse(res: ServerResponse, statusCode: number, body: string, contentType = "text/plain"): void {
  res.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": contentType,
  })
  res.end(body)
}

function listenOnLocalhost(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address === "object" && address) resolve(address.port)
      else reject(new Error("collector did not bind to a TCP port"))
    })
  })
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

interface FileWatcherHandle {
  stop: () => void
  eventsPath: string
  getEventCount: () => number
}

function startFileWatcher(cwd: string, captureRoot: string, captureId: string): FileWatcherHandle {
  const eventsPath = join(captureRoot, `${captureId}-file-watcher.jsonl`)
  let eventCount = 0
  const watchers: FSWatcher[] = []
  const fileSizes = new Map<string, number>()

  const logEvent = (type: string, filePath: string, data: string) => {
    eventCount += 1
    appendFileSync(
      eventsPath,
      `${JSON.stringify({ type, file: filePath, ts: new Date().toISOString(), data })}\n`,
      "utf-8",
    )
  }

  // Scan a directory for log files
  const scanDir = (dir: string) => {
    if (!existsSync(dir)) return
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isFile() && (entry.name.endsWith(".log") || entry.name.endsWith(".txt"))) {
          try {
            const size = statSync(fullPath).size
            fileSizes.set(fullPath, size)
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore permission errors
    }
  }

  // Watch a single file for changes
  const watchFile = (filePath: string) => {
    try {
      const watcher = watch(filePath, (eventType) => {
        if (eventType !== "change") return
        try {
          const currentSize = statSync(filePath).size
          const prevSize = fileSizes.get(filePath) ?? 0
          if (currentSize > prevSize) {
            // Read only the new content
            const fd = require("node:fs").openSync(filePath, "r")
            const buffer = Buffer.alloc(currentSize - prevSize)
            require("node:fs").readSync(fd, buffer, 0, buffer.length, prevSize)
            require("node:fs").closeSync(fd)
            const newContent = buffer.toString("utf-8")
            fileSizes.set(filePath, currentSize)
            logEvent("file_change", filePath, newContent.slice(-2000)) // cap at 2KB
          }
        } catch {
          // ignore
        }
      })
      watchers.push(watcher)
    } catch {
      // ignore
    }
  }

  // Watch a directory for new files
  const watchDir = (dir: string) => {
    if (!existsSync(dir)) return
    try {
      const watcher = watch(dir, (eventType, filename) => {
        if (!filename) return
        const fullPath = join(dir, filename)
        if (eventType === "rename") {
          try {
            if (existsSync(fullPath) && statSync(fullPath).isFile()) {
              logEvent("file_added", fullPath, "")
              watchFile(fullPath)
            }
          } catch {
            // ignore
          }
        }
      })
      watchers.push(watcher)
    } catch {
      // ignore
    }
  }

  // Watch common log locations
  const logDirs = [
    join(cwd, ".debug"),
    join(cwd, "logs"),
    join(cwd, "log"),
    join(cwd, "tmp"),
    join(cwd, ".next"),     // Next.js build output
    join(cwd, ".nuxt"),     // Nuxt build output
    join(cwd, "dist"),      // Build output
  ]

  for (const dir of logDirs) {
    scanDir(dir)
    watchDir(dir)
  }

  // Watch specific log files at project root
  try {
    const rootEntries = readdirSync(cwd, { withFileTypes: true })
    for (const entry of rootEntries) {
      if (entry.isFile() && entry.name.endsWith(".log")) {
        const fullPath = join(cwd, entry.name)
        try {
          fileSizes.set(fullPath, statSync(fullPath).size)
          watchFile(fullPath)
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  // Initial scan event
  logEvent("watcher_started", cwd, `Watching ${watchers.length} paths`)

  return {
    stop: () => {
      for (const w of watchers) {
        try { w.close() } catch { /* ignore */ }
      }
    },
    eventsPath,
    getEventCount: () => eventCount,
  }
}

interface ProcessWatcherHandle {
  stop: () => void
  eventsPath: string
  getEventCount: () => number
}

function startProcessWatcher(
  cwd: string,
  captureRoot: string,
  captureId: string,
  command: string,
): ProcessWatcherHandle {
  const eventsPath = join(captureRoot, `${captureId}-process.jsonl`)
  let eventCount = 0
  let proc: ReturnType<typeof spawn> | null = null

  const logEvent = (type: string, data: string) => {
    eventCount += 1
    appendFileSync(
      eventsPath,
      `${JSON.stringify({ type, ts: new Date().toISOString(), data: data.slice(-4000) })}\n`,
      "utf-8",
    )
  }

  try {
    const parts = command.split(/\s+/)
    const cmd = parts[0]
    const args = parts.slice(1)
    proc = spawn(cmd, args, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    })

    proc.stdout?.on("data", (data: Buffer) => {
      logEvent("stdout", data.toString())
    })

    proc.stderr?.on("data", (data: Buffer) => {
      logEvent("stderr", data.toString())
    })

    proc.on("close", (code) => {
      logEvent("process_exit", `exit code: ${code}`)
    })

    proc.on("error", (err) => {
      logEvent("process_error", err.message)
    })

    logEvent("process_started", command)
  } catch (err) {
    logEvent("process_error", err instanceof Error ? err.message : String(err))
  }

  return {
    stop: () => {
      if (proc && !proc.killed) {
        proc.kill("SIGTERM")
        setTimeout(() => {
          if (proc && !proc.killed) proc.kill("SIGKILL")
        }, 3000)
      }
    },
    eventsPath,
    getEventCount: () => eventCount,
  }
}

function runAdbCommand(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("adb", args, { encoding: "utf-8", timeout: 15_000 })
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  }
}

function checkAdbConnected(): { connected: boolean; device?: string; error?: string } {
  const result = runAdbCommand(["devices"])
  if (!result.ok) return { connected: false, error: `adb not available: ${result.stderr}` }
  const lines = result.stdout.split("\n").filter((line) => line.includes("\tdevice"))
  if (lines.length === 0) return { connected: false, error: "No Android device connected. Check USB connection and ensure USB debugging is enabled." }
  const serial = lines[0].split("\t")[0]
  return { connected: true, device: serial }
}

async function captureAndroidReproduction(
  ctx: ExtensionCommandContext,
  problemStatement: string,
): Promise<ReproductionCapture | undefined> {
  const adbStatus = checkAdbConnected()
  if (!adbStatus.connected) {
    ctx.ui.notify(adbStatus.error ?? "ADB not connected.", "error")
    return undefined
  }

  const captureRoot = getCaptureRoot(ctx.cwd)
  mkdirSync(captureRoot, { recursive: true })
  const startedAt = formatTimestamp()
  const captureId = startedAt.replace(/[-: ]/g, "")
  const eventsPath = join(captureRoot, `${captureId}-android-events.jsonl`)
  const snippetPath = join(captureRoot, `${captureId}-android-info.txt`)

  const captureMode = await ctx.ui.select(
    "Android Capture",
    ["Screenshot + logcat + activity info", "Screenshot only", "Logcat only", "Cancel"],
    { signal: ctx.signal },
  )
  if (!captureMode || captureMode === "Cancel") {
    ctx.ui.notify("Android capture cancelled.", "warning")
    return undefined
  }

  const events: string[] = []
  const captureLog = (type: string, data: string) => {
    events.push(JSON.stringify({ type, ts: new Date().toISOString(), data }))
  }

  // Screenshot
  if (captureMode !== "Logcat only") {
    const screenshotPath = join(captureRoot, `${captureId}-screenshot.png`)
    const screenshotResult = runAdbCommand(["exec-out", "screencap", "-p"])
    if (screenshotResult.ok && screenshotResult.stdout) {
      // adb exec-out screencap -p returns binary PNG data
      writeFileSync(screenshotPath, screenshotResult.stdout, "binary")
      captureLog("screenshot", screenshotPath)
      ctx.ui.notify(`Screenshot saved: ${screenshotPath}`, "info")
    } else {
      ctx.ui.notify(`Screenshot failed: ${screenshotResult.stderr}`, "warning")
    }
  }

  // Logcat
  if (captureMode !== "Screenshot only") {
    const logcatPath = join(captureRoot, `${captureId}-logcat.txt`)
    const logcatResult = runAdbCommand(["logcat", "-d", "-t", "500"])
    if (logcatResult.ok) {
      writeFileSync(logcatPath, logcatResult.stdout, "utf-8")
      captureLog("logcat", logcatPath)
      ctx.ui.notify(`Logcat saved: ${logcatPath} (${logcatResult.stdout.split("\n").length} lines)`, "info")
    } else {
      ctx.ui.notify(`Logcat failed: ${logcatResult.stderr}`, "warning")
    }
  }

  // Activity info
  const activityPath = join(captureRoot, `${captureId}-activity.txt`)
  const activityResult = runAdbCommand(["shell", "dumpsys", "activity", "top"])
  if (activityResult.ok) {
    writeFileSync(activityPath, activityResult.stdout, "utf-8")
    captureLog("activity", activityPath)
  }

  // UI hierarchy (optional, best effort)
  const uiDumpPath = join(captureRoot, `${captureId}-ui.xml`)
  const uiResult = runAdbCommand(["shell", "uiautomator", "dump", "/dev/tty"])
  if (uiResult.ok && uiResult.stdout.includes("<hierarchy")) {
    writeFileSync(uiDumpPath, uiResult.stdout, "utf-8")
    captureLog("ui_dump", uiDumpPath)
  }

  // Package info
  const packageInfoPath = join(captureRoot, `${captureId}-package-info.txt`)
  const currentActivity = runAdbCommand(["shell", "dumpsys", "window", "windows"])
  if (currentActivity.ok) {
    const focusLine = currentActivity.stdout.split("\n").find((l) => l.includes("mCurrentFocus") || l.includes("mFocusedApp"))
    if (focusLine) {
      writeFileSync(packageInfoPath, focusLine, "utf-8")
      captureLog("package_info", packageInfoPath)
    }
  }

  // Write events log
  writeFileSync(eventsPath, events.join("\n") + "\n", "utf-8")

  // Write summary info
  const infoLines = [
    `Android reproduction capture`,
    `Device: ${adbStatus.device}`,
    `Problem: ${problemStatement}`,
    `Started: ${startedAt}`,
    `Captured: ${events.length} artifacts`,
    "",
    "Artifacts:",
    ...events.map((e) => {
      const parsed = JSON.parse(e)
      return `- ${parsed.type}: ${parsed.data}`
    }),
  ]
  writeFileSync(snippetPath, infoLines.join("\n"), "utf-8")

  const capture: ReproductionCapture = {
    profile: "android-app",
    eventsPath,
    snippetPath,
    eventCount: events.length,
    startedAt,
    endedAt: formatTimestamp(),
    notes: `Captured ${events.length} Android artifacts for: ${problemStatement}`,
  }

  ctx.ui.notify([capture.notes, "", `Artifacts saved to: ${captureRoot}`].join("\n"), "info")
  return capture
}

async function captureReproductionLogs(
  ctx: ExtensionCommandContext,
  profile: DebugProfileDetection,
  problemStatement: string,
): Promise<ReproductionCapture | undefined> {
  // Android has its own dedicated capture flow
  if (profile.collector === "adb") {
    return captureAndroidReproduction(ctx, problemStatement)
  }

  const captureRoot = getCaptureRoot(ctx.cwd)
  mkdirSync(captureRoot, { recursive: true })
  const startedAt = formatTimestamp()
  const captureId = startedAt.replace(/[-: ]/g, "")

  // Always start file watcher to monitor project logs
  const fileWatcher = startFileWatcher(ctx.cwd, captureRoot, captureId)

  // For browser collectors, also start the HTTP event collector
  let server: Server | undefined
  let eventUrl = ""
  let snippetPath = ""
  let eventsPath = ""
  let eventCount = 0

  if (profile.collector === "browser") {
    eventsPath = join(captureRoot, `${captureId}-events.jsonl`)
    snippetPath = join(captureRoot, `${captureId}-browser-snippet.js`)

    server = createServer(async (req, res) => {
      if (req.method === "OPTIONS") {
        writeCollectorResponse(res, 204, "")
        return
      }
      if (req.method === "GET" && req.url === "/snippet.js") {
        writeCollectorResponse(res, 200, readFileSync(snippetPath, "utf-8"), "application/javascript")
        return
      }
      if (req.method === "POST" && req.url === "/event") {
        const body = await readRequestBody(req)
        eventCount += 1
        appendFileSync(eventsPath, `${JSON.stringify({ receivedAt: new Date().toISOString(), body })}\n`, "utf-8")
        writeCollectorResponse(res, 200, "ok")
        return
      }
      writeCollectorResponse(res, 404, "not found")
    })

    const port = await listenOnLocalhost(server)
    eventUrl = `http://127.0.0.1:${port}/event`
    writeFileSync(snippetPath, createBrowserCollectorSnippet(eventUrl), "utf-8")
  }

  // Build the user prompt based on collector type
  const promptLines = [
    "正在监控项目日志，请复现问题...",
    "",
    `问题: ${problemStatement}`,
  ]

  if (profile.collector === "browser" && eventUrl) {
    promptLines.push(
      "",
      "浏览器事件采集已启动：",
      `  Event URL: ${eventUrl}`,
      `  Snippet: ${snippetPath}`,
      "",
      "请在 DevTools Console 中粘贴 snippet，然后复现问题。",
    )
  }

  promptLines.push(
    "",
    "复现完后选择「停止采集」继续。",
  )

  ctx.ui.notify(promptLines.join("\n"), "info")

  const choice = await ctx.ui.select(
    "Reproduce Now",
    ["Stop capture and continue", "Cancel capture"],
    { signal: ctx.signal },
  )

  // Stop all watchers
  fileWatcher.stop()
  if (server) await closeServer(server)

  if (!choice || choice === "Cancel capture") {
    ctx.ui.notify("Reproduction capture cancelled. Continuing without captured logs.", "warning")
    return undefined
  }

  const totalEvents = eventCount + fileWatcher.getEventCount()
  const capture: ReproductionCapture = {
    profile: profile.id,
    eventsPath: eventsPath || join(captureRoot, `${captureId}-events.jsonl`),
    snippetPath: snippetPath || join(captureRoot, `${captureId}-snippet.txt`),
    eventCount,
    startedAt,
    endedAt: formatTimestamp(),
    notes: `Captured ${totalEvents} events (${eventCount} browser, ${fileWatcher.getEventCount()} file) for: ${problemStatement}`,
    fileWatcherEventsPath: fileWatcher.eventsPath,
    fileWatcherEventCount: fileWatcher.getEventCount(),
  }

  ctx.ui.notify([capture.notes, "", `Events: ${captureRoot}`].join("\n"), "info")
  return capture
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1]
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/")
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] }
  }

  const execName = dirname(process.execPath).toLowerCase()
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
  if (!isGenericRuntime) return { command: process.execPath, args }
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
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--append-system-prompt",
    workerPromptPath,
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

    const emitProgress = (lastEvent: string) => {
      stepCount += 1
      onProgress?.({ stepCount, lastEvent })
    }

    const processLine = (line: string) => {
      if (!line.trim()) return
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line) as Record<string, unknown>
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
      if (buffer.trim()) processLine(buffer.trim())
      result.exitCode = code ?? 0
      resolve(result)
    })

    proc.on("error", () => {
      result.exitCode = 1
      resolve(result)
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
    if (msg.role !== "assistant") continue
    for (const part of msg.content) {
      if (part.type === "text") return part.text
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

function skillPath(...segments: string[]): string {
  return join(getExtensionDir(), "skills", ...segments)
}

function resolveSkillPath(skillName: SkillName, cwd: string): string | null {
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

function getSkillLookupPaths(skillName: SkillName, cwd: string): string[] {
  return [
    skillPath(skillName, "SKILL.md"),
    join(homedir(), ".pi", "agent", "skills", skillName, "SKILL.md"),
    join(cwd, ".pi", "skills", skillName, "SKILL.md"),
    join(cwd, ".agents", "skills", skillName, "SKILL.md"),
  ]
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function formatProgress(progress?: WorkerProgress): string {
  if (!progress) return "waiting for worker events"
  if (progress.lastEvent === "tool_result") return `step ${progress.stepCount} | tool finished`
  if (progress.lastEvent === "stderr") return `step ${progress.stepCount} | stderr output`
  return `step ${progress.stepCount} | ${progress.lastEvent}`
}

function startWorkerStatus(
  ctx: ExtensionCommandContext,
  label: string,
): {
  update: (progress: WorkerProgress) => void
  finish: (ok: boolean) => void
} {
  const startedAt = Date.now()
  let latestProgress: WorkerProgress | undefined
  let lastText = ""

  const render = () => {
    const text = `Debug running: ${label} (${formatElapsed(Date.now() - startedAt)}) | ${formatProgress(latestProgress)}`
    lastText = text
    ctx.ui.setStatus("debug", text)
    ctx.ui.setWorkingVisible(true)
    ctx.ui.setWorkingMessage(text)
    ctx.ui.setWorkingIndicator({ frames: ["-", "\\", "|", "/"], intervalMs: 120 })
  }

  render()
  const interval = setInterval(render, 1000)

  return {
    update: (progress) => {
      latestProgress = progress
      render()
    },
    finish: (ok) => {
      clearInterval(interval)
      const text = `Debug ${ok ? "completed" : "failed"}: ${label}`
      ctx.ui.setStatus("debug", text)
      ctx.ui.setWorkingVisible(false)
      ctx.ui.setWorkingMessage()
      ctx.ui.setWorkingIndicator()
      if (lastText) ctx.ui.notify(text, ok ? "info" : "warning")
    },
  }
}

async function runJsonSkillWorker<T>(
  ctx: ExtensionCommandContext,
  skillName: SkillName,
  taskPrompt: string,
  statusLabel: string,
): Promise<{ data: T; rawOutput: string } | null> {
  const skillFilePath = resolveSkillPath(skillName, ctx.cwd)
  if (!skillFilePath) {
    const lookedIn = getSkillLookupPaths(skillName, ctx.cwd).map((path) => `- ${path}`).join("\n")
    ctx.ui.notify(`Could not find ${skillName} skill.\n\nLooked in:\n${lookedIn}`, "error")
    return null
  }

  const status = startWorkerStatus(ctx, statusLabel)
  const worker = await runWorker(ctx.cwd, taskPrompt, skillFilePath, ctx.signal, status.update)
  const ok = worker.exitCode === 0 || worker.completed
  status.finish(ok)

  const rawOutput = getFinalOutput(worker.messages)
  if (!ok) {
    ctx.ui.notify([`Failed while running ${skillName}.`, "", "Worker output:", rawOutput.slice(-1200)].join("\n"), "error")
    return null
  }

  const data = parseWorkerJsonOutput<T>(rawOutput)
  if (!data) {
    ctx.ui.notify([`Failed to parse ${skillName} output.`, "", "Worker output:", rawOutput.slice(-1200)].join("\n"), "error")
    return null
  }

  return { data, rawOutput }
}

async function promptBugReport(ctx: ExtensionCommandContext): Promise<string | undefined> {
  while (true) {
    const value = await ctx.ui.input("Describe Bug", "Describe the problem in your own words", { signal: ctx.signal })
    if (value === undefined) return undefined
    const trimmed = value.trim()
    if (trimmed) return trimmed
    ctx.ui.notify("Bug description cannot be empty.", "warning")
  }
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
  questions: DebugQuestion[],
): Promise<DebugAnswer[] | undefined> {
  const answers: DebugAnswer[] = []

  for (const question of questions) {
    if (question.options.length === 0) {
      const answer = await promptCustomClarification(ctx, question.question)
      if (answer === undefined) return undefined
      answers.push({ question: question.question, answer })
      continue
    }

    const choice = await ctx.ui.select(question.question, [...question.options, "Other"], { signal: ctx.signal })
    if (!choice) return undefined

    let answer = choice
    if (choice === "Other") {
      const customAnswer = await promptCustomClarification(ctx, question.question)
      if (customAnswer === undefined) return undefined
      answer = customAnswer
    }

    answers.push({ question: question.question, answer })
  }

  return answers
}

function formatClarifications(answers: DebugAnswer[]): string {
  if (answers.length === 0) return "No clarifications yet."
  return answers.map((answer, index) => `${index + 1}. ${answer.question}\nAnswer: ${answer.answer}`).join("\n\n")
}

async function confirmProblemStatement(
  ctx: ExtensionCommandContext,
  originalReport: string,
): Promise<{ problemStatement: string; clarifications: DebugAnswer[] } | null> {
  const clarifications: DebugAnswer[] = []
  let latestUnderstanding = originalReport

  while (true) {
    const prompt = [
      `Original bug report: ${originalReport}`,
      "",
      "Existing clarifications:",
      formatClarifications(clarifications),
    ].join("\n")

    const intakeResult = await runJsonSkillWorker<IntakeResult>(
      ctx,
      "debug-intake",
      prompt,
      "Understanding debug report",
    )
    if (!intakeResult) return null

    latestUnderstanding = intakeResult.data.understanding
    ctx.ui.notify(["AI understanding", "", latestUnderstanding].join("\n"), "info")

    if (intakeResult.data.questions.length > 0) {
      const answers = await askClarifyingQuestions(ctx, intakeResult.data.questions)
      if (answers === undefined) return null
      clarifications.push(...answers)
      continue
    }

    const choice = await ctx.ui.select(
      "Confirm Problem",
      ["Yes, this is the problem", "No, I need to add detail", "Cancel"],
      { signal: ctx.signal },
    )
    if (!choice || choice === "Cancel") return null
    if (choice === "Yes, this is the problem") {
      return { problemStatement: latestUnderstanding, clarifications }
    }

    const detail = await promptCustomClarification(ctx, "Add the missing or corrected detail")
    if (detail === undefined) return null
    clarifications.push({ question: "User correction", answer: detail })
  }
}

async function confirmDebugProfile(ctx: ExtensionCommandContext): Promise<DebugProfileDetection | null> {
  const detected = detectDebugProfile(ctx.cwd)
  ctx.ui.notify(formatProfileDetection(detected), "info")

  // High or medium confidence: auto-select, no questions asked
  if (detected.confidence === "high" || detected.confidence === "medium") {
    return detected
  }

  // Low confidence: let user confirm or override
  const profiles: DebugProfileDetection[] = [
    detected,
    { id: "browser-extension", label: "Browser extension", confidence: "low", evidence: ["selected manually"], collector: "browser" },
    { id: "web-app", label: "Web app", confidence: "low", evidence: ["selected manually"], collector: "browser" },
    { id: "cli", label: "CLI tool", confidence: "low", evidence: ["selected manually"], collector: "command" },
    { id: "api", label: "API service", confidence: "low", evidence: ["selected manually"], collector: "command" },
    { id: "electron", label: "Electron app", confidence: "low", evidence: ["selected manually"], collector: "browser" },
    { id: "android-app", label: "Android app", confidence: "low", evidence: ["selected manually"], collector: "adb" },
    { id: "generic", label: "Generic project", confidence: "low", evidence: ["selected manually"], collector: "manual" },
  ]
  const labels = [
    `Use detected: ${detected.label}`,
    "Browser extension",
    "Web app",
    "CLI tool",
    "API service",
    "Electron app",
    "Android app",
    "Generic project",
  ]

  const choice = await ctx.ui.select("Debug Profile", labels, { signal: ctx.signal })
  if (!choice) return null
  const index = labels.indexOf(choice)
  return profiles[index] ?? detected
}

async function confirmTestPlan(
  ctx: ExtensionCommandContext,
  profile: DebugProfileDetection,
  capture: ReproductionCapture | undefined,
  originalReport: string,
  problemStatement: string,
  clarifications: DebugAnswer[],
): Promise<DebugTestPlan | null> {
  const planNotes: DebugAnswer[] = []

  while (true) {
    const prompt = [
      `Project: ${getProjectName(ctx.cwd)}`,
      `Debug profile: ${profile.label} (${profile.id})`,
      `Original bug report: ${originalReport}`,
      "",
      "Confirmed problem:",
      problemStatement,
      "",
      "Clarifications:",
      formatClarifications([...clarifications, ...planNotes]),
      "",
      "Reproduction capture:",
      capture ? JSON.stringify(capture, null, 2) : "No reproduction capture was collected.",
    ].join("\n")

    const planResult = await runJsonSkillWorker<DebugTestPlan>(
      ctx,
      "debug-test-plan",
      prompt,
      "Designing debug test plan",
    )
    if (!planResult) return null

    ctx.ui.notify(formatTestPlan(planResult.data), "info")
    const choice = await ctx.ui.select(
      "Confirm Test Plan",
      ["Use this plan", "Revise the plan", "Cancel"],
      { signal: ctx.signal },
    )
    if (!choice || choice === "Cancel") return null
    if (choice === "Use this plan") return planResult.data

    const detail = await promptCustomClarification(ctx, "What should the test plan change?")
    if (detail === undefined) return null
    planNotes.push({ question: "Test plan revision", answer: detail })
  }
}

async function promptMaxIterations(ctx: ExtensionCommandContext): Promise<number | undefined> {
  while (true) {
    const value = await ctx.ui.input("Max Iterations", "Press Enter for 5, or enter a positive integer", {
      signal: ctx.signal,
    })
    if (value === undefined) return undefined
    const trimmed = value.trim()
    if (!trimmed) return 5
    if (/^\d+$/.test(trimmed) && parseInt(trimmed, 10) > 0) return parseInt(trimmed, 10)
    ctx.ui.notify("Max iterations must be a positive integer.", "warning")
  }
}

async function startDebugLoop(ctx: ExtensionCommandContext, task: DebugTask, maxIterations: number): Promise<void> {
  const workerSkillPath = resolveSkillPath("debug-worker", ctx.cwd)
  if (!workerSkillPath) {
    const lookedIn = getSkillLookupPaths("debug-worker", ctx.cwd).map((path) => `- ${path}`).join("\n")
    ctx.ui.notify(`Could not find debug-worker skill.\n\nLooked in:\n${lookedIn}`, "error")
    return
  }

  mkdirSync(getDebugRoot(ctx.cwd), { recursive: true })
  if (!existsSync(getProgressPath(ctx.cwd))) {
    writeFileSync(getProgressPath(ctx.cwd), `# pi-debug progress\nStarted: ${formatTimestamp()}\n---\n`, "utf-8")
  }

  let currentTask = { ...task, status: "running" as DebugStatus }
  writeCurrentTask(ctx.cwd, currentTask)

  for (let i = 1; i <= maxIterations; i++) {
    ctx.ui.notify(`Debug iteration ${i}/${maxIterations}: ${currentTask.problemStatement}`, "info")

    const taskPrompt = [
      `Task file: ${getCurrentTaskPath(ctx.cwd)}`,
      `Progress log: ${getProgressPath(ctx.cwd)}`,
      "",
      "Debug task JSON:",
      JSON.stringify(currentTask, null, 2),
      "",
      "Debug profile:",
      JSON.stringify(currentTask.profile, null, 2),
      "",
      "Reproduction capture:",
      currentTask.capture ? JSON.stringify(currentTask.capture, null, 2) : "No reproduction capture was collected.",
      "",
      "Complete exactly one autonomous debug iteration.",
    ].join("\n")

    const status = startWorkerStatus(ctx, `Iteration ${i}/${maxIterations}`)
    const worker = await runWorker(ctx.cwd, taskPrompt, workerSkillPath, ctx.signal, status.update)
    const ok = worker.exitCode === 0 || worker.completed
    status.finish(ok)

    const rawOutput = getFinalOutput(worker.messages)
    const workerJson = parseWorkerJsonOutput<WorkerJsonResult>(rawOutput)

    if (!ok) {
      currentTask = { ...currentTask, status: "failed", updatedAt: formatTimestamp() }
      writeCurrentTask(ctx.cwd, currentTask)
      ctx.ui.notify([`Debug worker failed with exit code ${worker.exitCode}.`, "", rawOutput.slice(-1200)].join("\n"), "error")
      return
    }

    if (workerJson?.completed || worker.completed) {
      currentTask = { ...currentTask, status: "completed", updatedAt: formatTimestamp() }
      writeCurrentTask(ctx.cwd, currentTask)
      const verified = await runVerifyStep(ctx, currentTask, rawOutput)
      if (!verified) return
      archiveCurrentTask(ctx.cwd, "completed")
      ctx.ui.notify(["Debug task completed", "", workerJson?.summary ?? rawOutput.slice(-1200)].join("\n"), "info")
      return
    }

    currentTask = readCurrentTask(ctx.cwd) ?? { ...currentTask, updatedAt: formatTimestamp() }
    if (currentTask.status === "completed") {
      archiveCurrentTask(ctx.cwd, "completed")
      ctx.ui.notify("Debug task completed.", "info")
      return
    }
  }

  currentTask = { ...currentTask, status: "failed", updatedAt: formatTimestamp() }
  writeCurrentTask(ctx.cwd, currentTask)
  ctx.ui.notify(`Reached max iterations (${maxIterations}). Debug task is still active.`, "warning")
}

async function runVerifyStep(ctx: ExtensionCommandContext, task: DebugTask, workerOutput: string): Promise<boolean> {
  const verifyResult = await runJsonSkillWorker<WorkerJsonResult>(
    ctx,
    "debug-verify",
    [
      "Confirmed problem:",
      task.problemStatement,
      "",
      "Test plan:",
      JSON.stringify(task.testPlan, null, 2),
      "",
      "Debug profile:",
      JSON.stringify(task.profile, null, 2),
      "",
      "Reproduction capture:",
      task.capture ? JSON.stringify(task.capture, null, 2) : "No reproduction capture was collected.",
      "",
      "Worker output:",
      workerOutput,
    ].join("\n"),
    "Verifying debug result",
  )

  if (!verifyResult) return false
  if (verifyResult.data.completed) {
    ctx.ui.notify(["Verification passed", "", verifyResult.data.summary].join("\n"), "info")
    return true
  }

  ctx.ui.notify(
    [
      "Verification did not pass.",
      "",
      verifyResult.data.summary,
      "",
      "Remaining issues:",
      ...verifyResult.data.remainingIssues.map((issue) => `- ${issue}`),
    ].join("\n"),
    "warning",
  )
  return false
}

async function handleNewDebugTask(ctx: ExtensionCommandContext, existingTask: DebugTask | null): Promise<boolean> {
  if (existingTask) {
    const shouldArchive = await ctx.ui.confirm(
      "Archive Active Debug Task?",
      [formatTaskSummary(existingTask), "", "Archive this active task before starting a new one?"].join("\n"),
      { signal: ctx.signal },
    )
    if (!shouldArchive) return false
    archiveCurrentTask(ctx.cwd, "replaced by new debug task")
  }

  // Step 1: Analyze project and show summary
  const packageSummary = readPackageSummary(ctx.cwd)
  const profile = detectDebugProfile(ctx.cwd)
  const scripts = packageSummary ? Object.keys(packageSummary.scripts).sort().join(", ") || "none" : "no package.json"
  ctx.ui.notify(
    [
      `Project: ${getProjectName(ctx.cwd)}`,
      `Detected: ${profile.label} (${profile.confidence})`,
      `Scripts: ${scripts}`,
      "",
      "What problem are you facing?",
    ].join("\n"),
    "info",
  )

  // Step 2: User describes the problem
  const originalReport = await promptBugReport(ctx)
  if (originalReport === undefined) return false

  // Step 3: AI understands and confirms the problem
  const confirmed = await confirmProblemStatement(ctx, originalReport)
  if (!confirmed) {
    ctx.ui.notify("Debug cancelled — problem was not confirmed.", "warning")
    return false
  }

  // Step 4: Auto-detect profile (auto-select for high/medium confidence)
  const finalProfile = await confirmDebugProfile(ctx)
  if (!finalProfile) {
    ctx.ui.notify("Cancelled before selecting a debug profile.", "warning")
    return false
  }

  // Step 5: Capture reproduction logs (file watcher + optional browser collector)
  let capture: ReproductionCapture | undefined
  const shouldCapture = await ctx.ui.select(
    "Capture Logs?",
    ["Yes, let me reproduce the issue", "No, skip capture"],
    { signal: ctx.signal },
  )
  if (shouldCapture === "Yes, let me reproduce the issue") {
    capture = await captureReproductionLogs(ctx, finalProfile, confirmed.problemStatement)
  }

  // Step 6: Auto-generate test plan (no user confirmation)
  const testPlanPrompt = [
    `Project: ${getProjectName(ctx.cwd)}`,
    `Debug profile: ${finalProfile.label} (${finalProfile.id})`,
    `Original bug report: ${originalReport}`,
    "",
    "Confirmed problem:",
    confirmed.problemStatement,
    "",
    "Clarifications:",
    formatClarifications(confirmed.clarifications),
    "",
    "Reproduction capture:",
    capture ? JSON.stringify(capture, null, 2) : "No reproduction capture was collected.",
  ].join("\n")

  const planResult = await runJsonSkillWorker<DebugTestPlan>(
    ctx,
    "debug-test-plan",
    testPlanPrompt,
    "Designing debug test plan",
  )
  if (!planResult) {
    ctx.ui.notify("Failed to generate a test plan.", "warning")
    return false
  }

  const testPlan = planResult.data

  // Step 7: Create task and start debug loop immediately
  const now = formatTimestamp()
  const task: DebugTask = {
    version: 1,
    id: createTaskId(),
    project: getProjectName(ctx.cwd),
    profile: finalProfile,
    originalReport,
    problemStatement: confirmed.problemStatement,
    clarifications: confirmed.clarifications,
    capture,
    testPlan,
    status: "ready",
    createdAt: now,
    updatedAt: now,
  }
  writeCurrentTask(ctx.cwd, task)

  ctx.ui.notify(
    [
      "Starting debug worker...",
      "",
      `Problem: ${task.problemStatement}`,
      `Profile: ${finalProfile.label}`,
      `Test plan: ${testPlan.summary}`,
    ].join("\n"),
    "info",
  )

  await startDebugLoop(ctx, task, 5)
  return true
}

async function handleContinueTask(ctx: ExtensionCommandContext, task: DebugTask): Promise<boolean> {
  ctx.ui.notify(formatTaskSummary(task), "info")
  const shouldResume = await ctx.ui.confirm(
    "Continue Active Debug Task?",
    [formatTaskSummary(task), "", "Resume autonomous repair and verification?"].join("\n"),
    { signal: ctx.signal },
  )
  if (!shouldResume) return false

  const maxIterations = await promptMaxIterations(ctx)
  if (maxIterations === undefined) return false
  await startDebugLoop(ctx, task, maxIterations)
  return true
}

async function handleCaptureForActiveTask(ctx: ExtensionCommandContext, task: DebugTask): Promise<boolean> {
  const capture = await captureReproductionLogs(ctx, task.profile, task.problemStatement)
  if (!capture) return false
  writeCurrentTask(ctx.cwd, { ...task, capture })
  ctx.ui.notify("Saved reproduction capture to the active debug task.", "info")
  return true
}

function formatHistoryEntry(entry: HistoryEntry): string {
  return [entry.updatedAt, entry.status, entry.problemStatement].join(" | ")
}

async function handleHistory(ctx: ExtensionCommandContext): Promise<boolean> {
  const entries = readHistoryIndex(ctx.cwd).entries
  if (entries.length === 0) {
    ctx.ui.notify("No pi-debug history was found.", "info")
    return false
  }

  while (true) {
    const labels = entries.map(formatHistoryEntry)
    const choice = await ctx.ui.select("Debug History", [...labels, "Back"], { signal: ctx.signal })
    if (!choice || choice === "Back") return false
    const index = labels.indexOf(choice)
    if (index === -1) return false
    const entry = entries[index]
    const task = readJsonFile(join(getArchiveRoot(ctx.cwd), entry.archiveDir, "task.json")) as DebugTask | null
    const progressPath = join(getArchiveRoot(ctx.cwd), entry.archiveDir, "progress.txt")
    const action = await ctx.ui.select("History Entry", ["View summary", "View progress log", "Back"], {
      signal: ctx.signal,
    })
    if (!action || action === "Back") continue
    if (action === "View summary") {
      ctx.ui.notify(task ? formatTaskSummary(task) : `History task missing: ${entry.archiveDir}`, task ? "info" : "warning")
      continue
    }
    if (action === "View progress log") {
      const progress = existsSync(progressPath) ? readFileSync(progressPath, "utf-8") : "No progress log found."
      ctx.ui.notify(progress.slice(-3000), "info")
    }
  }
}

function runGitCommand(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" })
  return {
    ok: result.status === 0,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  }
}

async function handleDiagnostics(ctx: ExtensionCommandContext): Promise<boolean> {
  const packageSummary = readPackageSummary(ctx.cwd)
  const gitBranch = runGitCommand(ctx.cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
  const debugRoot = getDebugRoot(ctx.cwd)
  const archiveCount = existsSync(getArchiveRoot(ctx.cwd))
    ? readdirSync(getArchiveRoot(ctx.cwd), { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
    : 0

  const lines = [
    `Project: ${getProjectName(ctx.cwd)}`,
    `CWD: ${ctx.cwd}`,
    `Git branch: ${gitBranch.ok ? gitBranch.stdout : "unknown"}`,
    `Debug root: ${debugRoot}`,
    `Archived tasks: ${archiveCount}`,
    "",
    "Package scripts:",
  ]

  if (packageSummary) {
    const scriptEntries = Object.entries(packageSummary.scripts).sort(([a], [b]) => a.localeCompare(b))
    if (scriptEntries.length === 0) lines.push("- none")
    for (const [name, command] of scriptEntries) lines.push(`- ${name}: ${command}`)
  } else {
    lines.push("- no package.json found")
  }

  ctx.ui.notify(lines.join("\n"), "info")
  return false
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("debug", undefined)
    ctx.ui.setWidget("debug-progress", undefined)
  })

  ensureSkillsInstalled()

  pi.registerCommand("debug", {
    description: "Open the interactive pi-debug workflow.",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("`/debug` does not accept parameters. Run `/debug` and follow the prompts.", "warning")
        return
      }

      while (true) {
        const currentTask = readCurrentTask(ctx.cwd)
        const historyEntries = readHistoryIndex(ctx.cwd).entries
        ctx.ui.notify(formatHomeSummary(ctx.cwd, currentTask, historyEntries), "info")

        const menuOptions: string[] = []
        if (currentTask && currentTask.status !== "completed" && currentTask.status !== "cancelled") {
          menuOptions.push("Continue active debug task")
          menuOptions.push("Capture reproduction logs")
        }
        menuOptions.push("New debug task")
        menuOptions.push("Run diagnostics")
        menuOptions.push("View history")
        menuOptions.push("Exit")

        const choice = await ctx.ui.select("Debug", menuOptions, { signal: ctx.signal })
        if (!choice || choice === "Exit") return

        if (choice === "Continue active debug task" && currentTask) {
          if (await handleContinueTask(ctx, currentTask)) return
          continue
        }

        if (choice === "Capture reproduction logs" && currentTask) {
          if (await handleCaptureForActiveTask(ctx, currentTask)) return
          continue
        }

        if (choice === "New debug task") {
          if (await handleNewDebugTask(ctx, currentTask)) return
          continue
        }

        if (choice === "Run diagnostics") {
          if (await handleDiagnostics(ctx)) return
          continue
        }

        if (choice === "View history") {
          if (await handleHistory(ctx)) return
          continue
        }
      }
    },
  })
}

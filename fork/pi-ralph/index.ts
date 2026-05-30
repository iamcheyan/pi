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

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import type { Message } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

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

// ============================================================================
// Self-install: symlink skills to ~/.pi/agent/skills/
// ============================================================================

const SKILLS = ["prd", "ralph", "ralph-worker", "ralph-wizard"] as const

function ensureSkillsInstalled(): void {
  const extensionDir = dirname(new URL(import.meta.url).pathname)
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
    "--dangerously-skip-permissions",
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
    })

    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer)
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
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text
      }
    }
  }
  return ""
}

// ============================================================================
// Resolve skill path
// ============================================================================

function skillPath(...segments: string[]): string {
  return join(dirname(new URL(import.meta.url).pathname), "skills", ...segments)
}

// ============================================================================
// Display helpers
// ============================================================================

function formatStatus(prd: PrdJson): string {
  const done = prd.userStories.filter((s) => s.passes).length
  const total = prd.userStories.length
  const remaining = total - done

  const lines = [
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
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI) {
  // Auto-install skills on first load
  ensureSkillsInstalled()

  pi.registerCommand("ralph", {
    description: "Ralph autonomous agent. /ralph <description> to setup, /ralph to run.",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd
      const prdPath = join(cwd, "prd.json")
      const progressPath = join(cwd, "progress.txt")
      const input = args.trim()

      const hasPrd = existsSync(prdPath)

      // ── No prd.json exists ──────────────────────────────────────────
      if (!hasPrd) {
        if (!input) {
          ctx.ui.notify([
            "Ralph — Autonomous Agent Loop",
            "",
            "No prd.json found. Let's set one up.",
            "",
            "Describe what you want to build:",
            "  /ralph add user authentication with JWT tokens",
            "  /ralph build a dashboard with charts and filters",
            "  /ralph refactor the API layer to use tRPC",
            "",
            "Ralph will generate a PRD, split it into stories,",
            "then run an autonomous loop to implement each one.",
          ].join("\n"), "info")
          return
        }

        ctx.ui.notify("Setting up Ralph for your feature...", "info")

        const wizardPromptPath = skillPath("ralph-wizard", "SKILL.md")
        const task = [
          "You are the Ralph setup wizard.",
          "Guide the user through creating a PRD and prd.json for this feature:",
          "",
          `Feature description: ${input}`,
          "",
          "Steps:",
          "1. Analyze the description and ask 2-3 clarifying questions (with lettered options)",
          "2. Generate a PRD with user stories and save to tasks/prd-[name].md",
          "3. Convert to prd.json format and save to the current directory",
          "4. Show a summary of what was created",
          "",
          "User stories must be small (completable in one session).",
          "Every story must include 'Typecheck passes' in acceptance criteria.",
          "UI stories must include 'Verify in browser' in acceptance criteria.",
        ].join("\n")

        const worker = await runWorker(cwd, task, wizardPromptPath, ctx.signal)

        if (worker.exitCode !== 0) {
          ctx.ui.notify(`Wizard failed (exit ${worker.exitCode}). Check the output above.`, "error")
          return
        }

        if (!existsSync(prdPath)) {
          const output = getFinalOutput(worker.messages)
          ctx.ui.notify([
            "Wizard finished but prd.json was not created.",
            "You can manually create it or run /ralph <description> again.",
            "",
            output.slice(-500),
          ].join("\n"), "warning")
          return
        }

        const prd = readJsonFile(prdPath) as PrdJson | null
        if (!prd) {
          ctx.ui.notify("prd.json was created but is invalid.", "error")
          return
        }

        const storyCount = prd.userStories.length
        ctx.ui.notify([
          "Setup complete!",
          "",
          formatStatus(prd),
          "",
          `Run /ralph to start the autonomous loop (${storyCount} stories).`,
        ].join("\n"), "info")

        return
      }

      // ── prd.json exists ─────────────────────────────────────────────
      const prd = readJsonFile(prdPath) as PrdJson | null
      if (!prd || !prd.userStories || !Array.isArray(prd.userStories)) {
        ctx.ui.notify("prd.json is invalid or has no userStories.", "error")
        return
      }

      if (allStoriesComplete(prd)) {
        ctx.ui.notify([
          "All stories complete!",
          "",
          formatStatus(prd),
          "",
          "Nothing to do. To start a new feature, run:",
          "  /ralph <feature description>",
        ].join("\n"), "info")
        return
      }

      const maxIterations = /^\d+$/.test(input) ? parseInt(input, 10) : 10

      archivePreviousRun(prdPath, progressPath)

      if (!existsSync(progressPath)) {
        writeFileSync(progressPath, `# Ralph Progress Log\nStarted: ${formatTimestamp()}\n---\n`, "utf-8")
      }

      const remaining = prd.userStories.filter((s) => !s.passes).length
      ctx.ui.notify([
        formatStatus(prd),
        "",
        `Starting autonomous loop — max ${maxIterations} iterations, ${remaining} stories remaining`,
      ].join("\n"), "info")

      const workerSkillPath = skillPath("ralph-worker", "SKILL.md")

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

        const worker = await runWorker(cwd, taskPrompt, workerSkillPath, ctx.signal)

        if (worker.exitCode !== 0 && !worker.completed) {
          ctx.ui.notify(`Iteration ${i}: worker exited with code ${worker.exitCode}`, "warning")
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
    },
  })
}

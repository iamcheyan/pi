/**
 * /spawn - Thin wrapper around pi-subagents
 *
 * Just parses args and delegates to pi-subagents via events.
 * All execution, display, and status management is handled by pi-subagents.
 *
 * Usage:
 *   /spawn <task>           - Spawn default worker agent
 *   /spawn <agent> <task>   - Spawn specific agent
 *   /spawn --list           - List available agents
 *   /spawn --status         - Show running subagents
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"

// Event names from pi-subagents
const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request"

function discoverAgents(cwd: string): Array<{ name: string; source: string }> {
  const agents: Array<{ name: string; source: string }> = []

  // pi-spawn bundled agents
  const bundledDir = path.join(path.dirname(new URL(import.meta.url).pathname), "agents")
  if (fs.existsSync(bundledDir)) {
    for (const file of fs.readdirSync(bundledDir)) {
      if (file.endsWith(".md")) agents.push({ name: file.replace(".md", ""), source: "bundled" })
    }
  }

  // User-level agents
  const userAgentsDir = path.join(os.homedir(), ".pi", "agent", "agents")
  if (fs.existsSync(userAgentsDir)) {
    for (const file of fs.readdirSync(userAgentsDir)) {
      if (file.endsWith(".md")) agents.push({ name: file.replace(".md", ""), source: "user" })
    }
  }

  // Project-level agents
  const projectAgentsDir = path.join(cwd, ".pi", "agents")
  if (fs.existsSync(projectAgentsDir)) {
    for (const file of fs.readdirSync(projectAgentsDir)) {
      if (file.endsWith(".md")) agents.push({ name: file.replace(".md", ""), source: "project" })
    }
  }

  return agents
}

export default function spawnCommandExtension(pi: ExtensionAPI) {
  const handler = async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim()

      // --list: show available agents
      if (trimmed === "--list" || trimmed === "-l") {
        const agents = discoverAgents(ctx.cwd)
        if (agents.length === 0) {
          ctx.ui.notify("没有找到 agent。在 ~/.pi/agent/agents/ 中创建 .md 文件。", "info")
          return
        }
        const list = agents.map(a => `- ${a.name} (${a.source})`).join("\n")
        ctx.ui.notify(`可用 agents:\n${list}`, "info")
        return
      }

      // Parse: [agent-name] <task>
      if (!trimmed) {
        ctx.ui.notify("用法:\n/spawn <task>       — 使用默认 worker\n/spawn <agent> <task> — 使用指定 agent\n/spawn --list        — 查看可用 agents\n\n简写: /s <task>", "info")
        return
      }

      const agents = discoverAgents(ctx.cwd)
      const firstWord = trimmed.split(/\s+/)[0]
      const agentMatch = agents.find(a => a.name === firstWord)

      let agentName: string
      let task: string

      if (agentMatch) {
        agentName = agentMatch.name
        task = trimmed.slice(firstWord.length).trim()
        if (!task) {
          ctx.ui.notify(`用法: /spawn ${agentName} <task>`, "info")
          return
        }
      } else {
        // Default to worker
        agentName = "worker"
        task = trimmed
      }

      // Check if agent exists (pi-subagents will discover it, but we can pre-check)
      if (!agents.find(a => a.name === agentName)) {
        const available = agents.map(a => a.name).join(", ") || "none"
        ctx.ui.notify(`未知 agent: ${agentName}\n可用: ${available}`, "error")
        return
      }

      // Delegate to pi-subagents via event system
      // This is the same thing /run does internally
      const requestId = randomUUID()
      const params = {
        agent: agentName,
        task,
        clarify: false,
        agentScope: "both" as const,
      }

      // Emit request - pi-subagents bridge will pick it up and execute
      pi.events.emit(SLASH_SUBAGENT_REQUEST_EVENT, { requestId, params })
  }

  // /spawn command
  pi.registerCommand("spawn", {
    description: "Spawn a subagent: /spawn <task> or /spawn <agent> <task>",
    handler,
  })

  // /s shorthand
  pi.registerCommand("s", {
    description: "Shorthand for /spawn",
    handler,
  })
}

/**
 * Spawn Command Extension
 *
 * Allows users to spawn subagents directly from the command line.
 *
 * Usage:
 *   /spawn <task>           - Spawn a worker agent with the task
 *   /spawn <agent> <task>   - Spawn a specific agent with the task
 *   /spawn --list           - List available agents
 *   /spawn --status         - Show running subagents
 *
 * Examples:
 *   /spawn 修复登录页面的样式问题
 *   /spawn reviewer 检查最新的提交
 *   /spawn scout 搜索所有 API 端点
 *
 * The spawned agent runs in a separate pi process and doesn't block
 * the main session. You can continue chatting while it works.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface SpawnedAgent {
	id: string;
	agent: string;
	task: string;
	pid: number;
	startedAt: Date;
	status: "running" | "completed" | "failed" | "aborted";
	output: string;
	exitCode?: number;
}

const runningAgents: Map<string, SpawnedAgent> = new Map();

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function createAgentId(): string {
	return `spawn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function discoverAgents(cwd: string): Array<{ name: string; path: string; source: string }> {
	const agents: Array<{ name: string; path: string; source: string }> = [];

	// User-level agents
	const userAgentsDir = path.join(os.homedir(), ".pi", "agent", "agents");
	if (fs.existsSync(userAgentsDir)) {
		for (const file of fs.readdirSync(userAgentsDir)) {
			if (file.endsWith(".md")) {
				agents.push({
					name: file.replace(".md", ""),
					path: path.join(userAgentsDir, file),
					source: "user",
				});
			}
		}
	}

	// Project-level agents
	const projectAgentsDir = path.join(cwd, ".pi", "agents");
	if (fs.existsSync(projectAgentsDir)) {
		for (const file of fs.readdirSync(projectAgentsDir)) {
			if (file.endsWith(".md")) {
				agents.push({
					name: file.replace(".md", ""),
					path: path.join(projectAgentsDir, file),
					source: "project",
				});
			}
		}
	}

	return agents;
}

export default function spawnCommandExtension(pi: ExtensionAPI) {
	pi.registerCommand("spawn", {
		description: "Spawn a subagent to work on a task in the background",
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();

			// Handle --list
			if (trimmedArgs === "--list" || trimmedArgs === "-l") {
				const agents = discoverAgents(ctx.cwd);
				if (agents.length === 0) {
					ctx.ui.notify("No agents found. Create agent definitions in ~/.pi/agent/agents/", "info");
					return;
				}

				const items = agents.map((a) => `${a.name} (${a.source})`);
				const selected = await ctx.ui.select("Available Agents", [...items, "Cancel"], { signal: ctx.signal });
				if (!selected || selected === "Cancel") return;

				const agent = agents.find((a) => `${a.name} (${a.source})` === selected);
				if (agent) {
					const task = await ctx.ui.input("Task", `What should ${agent.name} do?`, { signal: ctx.signal });
					if (!task) return;
					// Fall through to spawn with this agent
					return spawnAgent(ctx, agent.name, task.trim());
				}
				return;
			}

			// Handle --status
			if (trimmedArgs === "--status" || trimmedArgs === "-s") {
				if (runningAgents.size === 0) {
					ctx.ui.notify("No subagents running.", "info");
					return;
				}

				const items = Array.from(runningAgents.values()).map((a) => {
					const elapsed = Math.round((Date.now() - a.startedAt.getTime()) / 1000);
					return `[${a.status}] ${a.agent}: ${a.task.slice(0, 50)}... (${elapsed}s)`;
				});
				items.push("Cancel");
				const selected = await ctx.ui.select("Running Subagents", items, { signal: ctx.signal });
				if (!selected || selected === "Cancel") return;

				const idx = items.indexOf(selected);
				if (idx >= 0) {
					const agent = Array.from(runningAgents.values())[idx];
					const action = await ctx.ui.select("Subagent", ["View output", "Abort", "Cancel"], {
						signal: ctx.signal,
					});
					if (action === "View output") {
						ctx.ui.notify(agent.output.slice(-3000) || "(no output yet)", "info");
					} else if (action === "Abort") {
						process.kill(agent.pid, "SIGTERM");
						agent.status = "aborted";
						ctx.ui.notify(`Aborted subagent: ${agent.agent}`, "info");
					}
				}
				return;
			}

			// Parse arguments: [agent-name] <task>
			if (!trimmedArgs) {
				ctx.ui.notify(
					"Usage: /spawn <task> or /spawn <agent> <task>\nUse /spawn --list to see available agents",
					"warning",
				);
				return;
			}

			const agents = discoverAgents(ctx.cwd);
			const firstWord = trimmedArgs.split(/\s+/)[0];
			const agentMatch = agents.find((a) => a.name === firstWord);

			if (agentMatch) {
				const task = trimmedArgs.slice(firstWord.length).trim();
				if (!task) {
					ctx.ui.notify("Usage: /spawn <agent> <task>", "warning");
					return;
				}
				return spawnAgent(ctx, agentMatch.name, task);
			}

			// No agent name matched, use default "worker" agent
			return spawnAgent(ctx, "worker", trimmedArgs);
		},
	});

	async function spawnAgent(ctx: ExtensionCommandContext, agentName: string, task: string): Promise<void> {
		const agentId = createAgentId();
		const agents = discoverAgents(ctx.cwd);
		const agent = agents.find((a) => a.name === agentName);

		if (!agent) {
			const available = agents.map((a) => a.name).join(", ") || "none (create agents in ~/.pi/agent/agents/)";
			ctx.ui.notify(`Unknown agent: "${agentName}". Available: ${available}`, "error");
			return;
		}

		ctx.ui.notify(`Spawning ${agentName}: ${task.slice(0, 80)}...`, "info");

		const args: string[] = ["--mode", "json", "-p", "--no-session"];
		args.push("--append-system-prompt", agent.path);
		args.push(`Task: ${task}`);

		const spawned: SpawnedAgent = {
			id: agentId,
			agent: agentName,
			task,
			pid: 0,
			startedAt: new Date(),
			status: "running",
			output: "",
		};

		const invocation = getPiInvocation(args);
		const proc = spawn(invocation.command, invocation.args, {
			cwd: ctx.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		spawned.pid = proc.pid;
		runningAgents.set(agentId, spawned);

		let buffer = "";
		proc.stdout.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					if (event.type === "message_end" && event.message?.role === "assistant") {
						for (const part of event.message.content) {
							if (part.type === "text") {
								spawned.output = part.text;
							}
						}
					}
				} catch {
					// ignore parse errors
				}
			}
		});

		proc.stderr.on("data", (data: Buffer) => {
			spawned.output += data.toString();
		});

		proc.on("close", (code) => {
			spawned.exitCode = code ?? 0;
			spawned.status = code === 0 ? "completed" : "failed";
			runningAgents.delete(agentId);
			ctx.ui.notify(
				`Subagent ${agentName} ${spawned.status}: ${task.slice(0, 60)}`,
				spawned.status === "completed" ? "info" : "warning",
			);
		});

		proc.on("error", (err) => {
			spawned.status = "failed";
			spawned.output = err.message;
			runningAgents.delete(agentId);
			ctx.ui.notify(`Subagent ${agentName} failed: ${err.message}`, "error");
		});

		// Handle abort
		if (ctx.signal) {
			ctx.signal.addEventListener(
				"abort",
				() => {
					proc.kill("SIGTERM");
					spawned.status = "aborted";
				},
				{ once: true },
			);
		}

		ctx.ui.notify(
			`✓ ${agentName} started (PID: ${proc.pid})\n  Task: ${task}\n  Use /spawn --status to check progress`,
			"info",
		);
	}
}

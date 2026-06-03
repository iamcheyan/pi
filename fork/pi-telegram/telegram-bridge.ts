/**
 * pi Telegram Bridge
 *
 * Runs a Telegram bot that forwards messages to a pi coding agent (via RPC)
 * and sends responses back to Telegram.
 *
 * Usage:
 *   npm install
 *   npm start
 *
 * Config: telegram-config.json (gitignored)
 *   { "botToken": "...", "chatId": "..." }
 */

import { Bot, webhookCallback } from "grammy";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";

// --- Config ---

interface TelegramConfig {
  botToken: string;
  chatId: string;
}

function loadConfig(): TelegramConfig {
  const candidates = [
    resolve(dirname(new URL(import.meta.url).pathname), "telegram-config.json"),
    resolve(process.env.HOME ?? "~", ".pi", "agent", "extensions", "telegram-config.json"),
    resolve(process.cwd(), "telegram-config.json"),
  ];

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf-8");
      const config = JSON.parse(raw) as TelegramConfig;
      if (config.botToken && config.chatId) return config;
    } catch {}
  }

  throw new Error("telegram-config.json not found. Create it with botToken and chatId.");
}

const config = loadConfig();

// --- pi RPC Client ---

type RpcEvent = Record<string, unknown> & { type: string };

class PiRpcClient {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private pendingPrompt: {
    resolve: (text: string) => void;
    reject: (err: Error) => void;
  } | null = null;
  private responseText = "";
  private isProcessing = false;
  private queue: Array<{ message: string; chatId: number }> = [];

  start() {
    this.spawnProcess();
  }

  private spawnProcess() {
    console.log("[pi] spawning pi rpc process...");
    this.proc = spawn(
      "/Users/tetsuya/Development/pi/fork/dist/pi-darwin-arm64/bin/pi",
      ["--mode", "rpc", "--no-session"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    this.proc.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error("[pi:stderr]", text);
    });
    this.proc.on("exit", (code) => {
      console.log(`[pi] process exited with code ${code}`);
      this.proc = null;
      if (this.pendingPrompt) {
        this.pendingPrompt.reject(new Error(`pi exited with code ${code}`));
        this.pendingPrompt = null;
      }
      setTimeout(() => this.spawnProcess(), 3000);
    });

    console.log("[pi] rpc process started");
  }

  private onStdout(chunk: Buffer) {
    const decoder = new StringDecoder("utf8");
    this.buffer += decoder.write(chunk);

    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) break;

      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;

      try {
        this.handleEvent(JSON.parse(line) as RpcEvent);
      } catch {
        console.error("[pi] bad json:", line.slice(0, 200));
      }
    }
  }

  private handleEvent(event: RpcEvent) {
    switch (event.type) {
      case "message_update": {
        const ase = event.assistantMessageEvent as Record<string, unknown> | undefined;
        if (ase?.type === "text_delta") {
          this.responseText += (ase.delta as string) ?? "";
        }
        break;
      }
      case "tool_execution_start": {
        const name = event.toolName as string;
        const args = event.args as Record<string, unknown> | undefined;
        if (name === "bash") {
          this.responseText += `\n[tool: bash] ${(args?.command as string ?? "").slice(0, 100)}\n`;
        } else if (name === "read") {
          this.responseText += `\n[tool: read] ${args?.path as string ?? ""}\n`;
        }
        break;
      }
      case "agent_end": {
        if (this.pendingPrompt) {
          const text = this.responseText.trim() || "(no response)";
          this.pendingPrompt.resolve(text);
          this.pendingPrompt = null;
        }
        this.processQueue();
        break;
      }
      case "response": {
        if (event.success === false) {
          console.error("[pi] command error:", event.error);
        }
        break;
      }
    }
  }

  async sendPrompt(message: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) {
        reject(new Error("pi process not running"));
        return;
      }
      this.responseText = "";
      this.pendingPrompt = { resolve, reject };
      this.proc.stdin.write(JSON.stringify({ type: "prompt", message }) + "\n");
    });
  }

  enqueue(message: string, chatId: number) {
    this.queue.push({ message, chatId });
    if (!this.isProcessing) this.processQueue();
  }

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;
    const { message, chatId } = this.queue.shift()!;
    try {
      const response = await this.sendPrompt(message);
      this.onResponse?.(response, chatId);
    } catch (err) {
      this.onResponse?.(`Error: ${err instanceof Error ? err.message : String(err)}`, chatId);
    } finally {
      this.isProcessing = false;
      if (this.queue.length > 0) this.processQueue();
    }
  }

  onResponse: ((text: string, chatId: number) => void) | null = null;

  stop() {
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill();
      this.proc = null;
    }
  }
}

// --- Telegram Bot with 409 retry ---

async function startBot(pi: PiRpcClient): Promise<void> {
  const bot = new Bot(config.botToken);

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    if (String(chatId) !== config.chatId) {
      console.log(`[tg] ignored message from chat ${chatId}`);
      return;
    }

    const text = ctx.message.text.trim();
    if (!text) return;

    if (text === "/ping") { await ctx.reply("pong"); return; }
    if (text === "/status") { await ctx.reply(`Queue: ${pi["queue"].length} pending`); return; }
    if (text === "/abort") {
      if (pi["proc"]?.stdin?.writable) {
        pi["proc"].stdin.write(JSON.stringify({ type: "abort" }) + "\n");
        await ctx.reply("Abort signal sent.");
      } else {
        await ctx.reply("pi process not running.");
      }
      return;
    }

    console.log(`[tg] <- ${text.slice(0, 100)}`);
    await ctx.reply("Processing...", { reply_parameters: { message_id: ctx.message.message_id } });
    pi.enqueue(text, chatId);
  });

  pi.onResponse = async (text: string, chatId: number) => {
    console.log(`[tg] -> ${text.slice(0, 100)}`);
    for (const chunk of splitMessage(text, 4096)) {
      try { await bot.api.sendMessage(chatId, chunk); }
      catch (err) { console.error("[tg] send error:", err); }
    }
  };

  // Force takeover: aggressive fixed-interval retry to win the polling slot
  // morph uses max_concurrency:3 with exponential backoff, so we use short fixed delay
  const FORCE_MODE = process.argv.includes('--force');
  const MAX_RETRIES = FORCE_MODE ? Infinity : 600; // 10 minutes at 1s intervals
  const RETRY_DELAY = 1000; // 1 second - aggressive enough to beat morph's backoff

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[tg] starting bot (attempt ${attempt})...`);
      await bot.start({
        onStart: (info) => {
          console.log(`[tg] bot started as @${info.username}`);
          console.log(`[tg] listening for messages from chat ${config.chatId}`);
        },
      });
      return; // clean exit
    } catch (err: unknown) {
      const is409 = err instanceof Error && err.message.includes("409");
      if (!is409) throw err;

      if (attempt % 10 === 0) {
        console.log(`[tg] still waiting for polling slot (attempt ${attempt})...`);
      }
      await sleep(RETRY_DELAY);
    }
  }

  throw new Error(
    "Failed to start bot after max retries.\n" +
    "Another instance (morph?) is still polling this bot token.\n" +
    "Solutions:\n" +
    "  1. Stop the remote morph service\n" +
    "  2. Create a new bot with @BotFather and update telegram-config.json\n" +
    "  3. Use --force flag to retry indefinitely: npm start -- --force"
  );
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Main ---

async function checkBotStatus(token: string): Promise<void> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const data = await resp.json() as { ok: boolean; result: { url: string; pending_update_count: number } };
    if (data.ok) {
      const { url, pending_update_count } = data.result;
      console.log(`[tg] webhook url: ${url || "(none)"}`);
      console.log(`[tg] pending updates: ${pending_update_count}`);
      if (url) {
        console.log("[tg] warning: webhook is set, deleting it before polling...");
        await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=true`);
      }
    }
  } catch (err) {
    console.error("[tg] failed to check webhook status:", err);
  }
}

async function main() {
  // Diagnostics
  console.log("[tg] checking bot status...");
  await checkBotStatus(config.botToken);

  const pi = new PiRpcClient();
  pi.start();

  const shutdown = () => {
    console.log("\n[bridge] shutting down...");
    pi.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await startBot(pi);
}

main().catch((err) => {
  console.error("[bridge] fatal:", err);
  process.exit(1);
});

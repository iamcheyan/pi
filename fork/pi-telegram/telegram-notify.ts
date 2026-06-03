import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawn, execSync } from "node:child_process";

interface TelegramConfig {
  botToken: string;
  chatId: string;
}

function loadConfig(): TelegramConfig {
  const home = process.env.HOME ?? "~";
  const candidates = [
    resolve("/Users/tetsuya/Development/pi/fork/pi-telegram", "telegram-config.json"),
    resolve(home, ".pi", "agent", "extensions", "telegram-config.json"),
    resolve(process.cwd(), "telegram-config.json"),
  ];

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf-8");
      const config = JSON.parse(raw) as TelegramConfig;
      if (config.botToken && config.chatId) {
        return config;
      }
    } catch {
      // try next
    }
  }

  throw new Error(
    "telegram-config.json not found. Place it next to telegram-notify.ts or in ~/.pi/agent/extensions/"
  );
}

async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  parseMode?: string
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body: Record<string, string> = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as {
    ok: boolean;
    result?: unknown;
    description?: string;
  };

  return {
    ok: data.ok,
    result: data.result,
    error: data.ok ? undefined : data.description,
  };
}

// --- Bridge Process Management ---

const PID_DIR = resolve(process.env.HOME ?? "~", ".pi");
const PID_FILE = resolve(PID_DIR, "telegram-bridge.pid");
const LOG_FILE = resolve(PID_DIR, "telegram-bridge.log");

function getBridgePid(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (isNaN(pid)) return null;
    // Check if process is alive
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      // Process not running, clean up stale PID file
      return null;
    }
  } catch {
    return null;
  }
}

function isBridgeRunning(): boolean {
  return getBridgePid() !== null;
}

async function checkBotStatus(botToken: string): Promise<string> {
  const lines: string[] = [];

  // Bot info
  try {
    const meResp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const meData = (await meResp.json()) as {
      ok: boolean;
      result?: { username: string; first_name: string; id: number };
    };
    if (meData.ok && meData.result) {
      lines.push(`Bot: @${meData.result.username} (${meData.result.first_name})`);
      lines.push(`ID: ${meData.result.id}`);
    } else {
      lines.push("Error: Failed to get bot info");
    }
  } catch (e) {
    lines.push(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Webhook info
  try {
    const whResp = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
    const whData = (await whResp.json()) as {
      ok: boolean;
      result?: { url: string; pending_update_count: number; last_error_date?: number; last_error_message?: string };
    };
    if (whData.ok && whData.result) {
      const { url, pending_update_count, last_error_date, last_error_message } = whData.result;
      lines.push(`Webhook: ${url || "(none - using polling)"}`);
      lines.push(`Pending updates: ${pending_update_count}`);
      if (last_error_date && last_error_message) {
        const errDate = new Date(last_error_date * 1000).toLocaleString();
        lines.push(`Last error: ${errDate} - ${last_error_message}`);
      }
    }
  } catch (e) {
    lines.push(`Webhook check failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Bridge status
  const pid = getBridgePid();
  lines.push(`Bridge: ${pid ? `running (PID ${pid})` : "stopped"}`);

  return lines.join("\n");
}

async function sendTestMessage(botToken: string, chatId: string): Promise<string> {
  const result = await sendTelegramMessage(botToken, chatId, "pi test message");
  if (result.ok) {
    return "Test message sent successfully";
  }
  return `Failed: ${result.error ?? "unknown error"}`;
}

function startBridge(): string {
  if (isBridgeRunning()) {
    return "Bridge is already running";
  }

  const bridgePath = resolve("/Users/tetsuya/Development/pi/fork/pi-telegram/telegram-bridge.ts");
  if (!existsSync(bridgePath)) {
    return `Error: telegram-bridge.ts not found at ${bridgePath}`;
  }

  const logFd = openSync(LOG_FILE, "w");
  const child = spawn("npx", ["tsx", bridgePath], {
    cwd: dirname(bridgePath),
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);

  if (child.pid) {
    if (!existsSync(PID_DIR)) mkdirSync(PID_DIR, { recursive: true });
    writeFileSync(PID_FILE, String(child.pid));
    return `Bridge started (PID ${child.pid})\nLogs: ${LOG_FILE}`;
  }
  return "Error: Failed to start bridge process";
}

function stopBridge(): string {
  const pid = getBridgePid();
  if (!pid) {
    return "Bridge is not running";
  }

  try {
    process.kill(pid, "SIGTERM");
    // Wait briefly and check if it died
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        // still alive, wait a bit
        execSync("sleep 0.2");
      } catch {
        break; // dead
      }
    }
    // Force kill if still alive
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      // already dead
    }
    return "Bridge stopped";
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    try {
      unlinkSync(PID_FILE);
    } catch {}
  }
}

function viewBridgeLogs(): string {
  if (!existsSync(LOG_FILE)) {
    return "No log file found. Start the bridge first.";
  }
  try {
    const content = readFileSync(LOG_FILE, "utf-8");
    if (!content.trim()) {
      return "Log file is empty.";
    }
    // Show last 30 lines
    const lines = content.split("\n");
    const tail = lines.slice(-30).join("\n");
    return `--- Last ${Math.min(30, lines.length)} lines ---\n${tail}`;
  } catch (e) {
    return `Error reading logs: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function checkConfig(config: TelegramConfig): string {
  const masked = config.botToken.slice(0, 10) + "..." + config.botToken.slice(-5);
  return [
    `Bot Token: ${masked}`,
    `Chat ID: ${config.chatId}`,
  ].join("\n");
}

// --- Extension ---

export default function (pi: ExtensionAPI) {
  let config: TelegramConfig;
  try {
    config = loadConfig();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[telegram-notify] ${msg}`);
    return;
  }

  pi.registerTool({
    name: "telegram_send",
    label: "Telegram Send",
    description:
      "Send a message to the user's Telegram chat. Use this to notify the user of important results, completion of long tasks, or when you need their attention outside the terminal.",
    promptSnippet: "Send a Telegram notification to the user",
    promptGuidelines: [
      "Use telegram_send to notify the user via Telegram when a long-running task finishes, or when you need their attention outside the terminal.",
    ],
    parameters: Type.Object({
      message: Type.String({
        description: "Message text to send (max 4096 chars)",
      }),
      parse_mode: Type.Optional(
        Type.String({
          description:
            "Parse mode: 'MarkdownV2', 'HTML', or omit for plain text",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const text = params.message.slice(0, 4096);
      const result = await sendTelegramMessage(
        config.botToken,
        config.chatId,
        text,
        params.parse_mode
      );

      if (result.ok) {
        return {
          content: [
            {
              type: "text",
              text: `Message sent to Telegram chat ${config.chatId}`,
            },
          ],
          details: {
            messageId: (result.result as { message_id?: number })?.message_id,
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Failed to send Telegram message: ${result.error ?? "unknown error"}`,
          },
        ],
        isError: true,
      };
    },
  });

  pi.registerCommand("tg", {
    description: "Telegram management menu (or /tg <message> to send directly)",
    handler: async (args, ctx) => {
      // If args provided, send message directly (backward compatible)
      if (args) {
        const result = await sendTelegramMessage(config.botToken, config.chatId, args);
        if (result.ok) {
          ctx.ui.notify("Sent to Telegram", "info");
        } else {
          ctx.ui.notify(`Failed: ${result.error}`, "error");
        }
        return;
      }

      // Interactive menu
      const MENU_OPTIONS = [
        "查看 Bot 状态",
        "发送测试消息",
        "启动 Bridge 服务",
        "停止 Bridge 服务",
        "查看 Bridge 日志",
        "检查配置",
      ];

      const choice = await ctx.ui.select("Telegram 管理", MENU_OPTIONS);
      if (!choice) return;

      switch (choice) {
        case "查看 Bot 状态": {
          ctx.ui.notify("Checking bot status...", "info");
          const status = await checkBotStatus(config.botToken);
          ctx.ui.notify(status, "info");
          break;
        }
        case "发送测试消息": {
          const result = await sendTestMessage(config.botToken, config.chatId);
          ctx.ui.notify(result, result.includes("success") ? "info" : "error");
          break;
        }
        case "启动 Bridge 服务": {
          const result = startBridge();
          ctx.ui.notify(result, result.includes("started") ? "info" : "error");
          break;
        }
        case "停止 Bridge 服务": {
          const result = stopBridge();
          ctx.ui.notify(result, result.includes("stopped") ? "info" : "error");
          break;
        }
        case "查看 Bridge 日志": {
          const logs = viewBridgeLogs();
          ctx.ui.notify(logs, "info");
          break;
        }
        case "检查配置": {
          const info = checkConfig(config);
          ctx.ui.notify(info, "info");
          break;
        }
      }
    },
  });
}

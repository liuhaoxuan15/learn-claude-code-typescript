#!/usr/bin/env node
/**
 * s06.ts - Compact
 *
 * Three-layer compression pipeline so the agent can work forever:
 *
 *     Every turn:
 *     +------------------+
 *     | Tool call result |
 *     +------------------+
 *             |
 *             v
 *     [Layer 1: micro_compact]        (silent, every turn)
 *       Replace tool_result content older than last 3
 *       with "[Previous: used {tool_name}]"
 *             |
 *             v
 *     [Check: tokens > 50000?]
 *        |               |
 *        no              yes
 *        |               |
 *        v               v
 *     continue    [Layer 2: auto_compact]
 *                   Save full transcript to .transcripts/
 *                   Ask LLM to summarize conversation.
 *                   Replace all messages with [summary].
 *                         |
 *                         v
 *                 [Layer 3: compact tool]
 *                   Model calls compact -> immediate summarization.
 *                   Same as auto, triggered manually.
 *
 * Key insight: "The agent can forget strategically and keep working forever."
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as readline from "node:readline";
import * as child_process from "node:child_process";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { Anthropic } from "@anthropic-ai/sdk";

config({ override: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKDIR = path.resolve(__dirname, "..", "..");
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID || "claude-sonnet-4-6";

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

const THRESHOLD = 50000;
const KEEP_RECENT = 3;

// =============================================================================
// Compression (三层压缩策略)
// =============================================================================

// 简化估算：按 JSON 长度 / 4 近似 token 数
function estimate_tokens(messages: Message[]): number {
  return JSON.stringify(messages).length / 4;
}

// Layer 1: 微压缩 - 保留最近 3 个 tool_result，过早的替换为 "[Previous: used {tool_name}]"
function micro_compact(messages: Message[]): void {
  const toolResults: { msgIdx: number; partIdx: number; result: ToolResultBlock }[] = [];

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
        const part = msg.content[partIdx] as ToolResultBlock;
        if (typeof part === "object" && part !== null && part.type === "tool_result") {
          toolResults.push({ msgIdx, partIdx, result: part });
        }
      }
    }
  }

  if (toolResults.length <= KEEP_RECENT) return;

  const toolNameMap: Record<string, string> = {};
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content as AssistantContentBlock[]) {
        if (block.type === "tool_use") {
          toolNameMap[block.id] = block.name;
        }
      }
    }
  }

  for (const { result } of toolResults.slice(0, -KEEP_RECENT)) {
    if (typeof result.content === "string" && result.content.length > 100) {
      const toolName = toolNameMap[result.tool_use_id] || "unknown";
      result.content = `[Previous: used ${toolName}]`;
    }
  }
}

// Layer 2: 自动压缩 - 超出阈值时，将完整对话保存到 .transcripts/，然后用 LLM 摘要替换
async function auto_compact(messages: Message[]): Promise<Message[]> {
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  fs.writeFileSync(transcriptPath, messages.map((m) => JSON.stringify(m)).join("\n"), { encoding: "utf-8" });
  console.log(`[transcript saved: ${transcriptPath}]`);

  const conversationText = JSON.stringify(messages).slice(0, 80000);
  const response: any = await client.messages.create({
    model: MODEL,
    messages: [
      {
        role: "user",
        content:
          "Summarize this conversation for continuity. Include: " +
          "1) What was accomplished, 2) Current state, 3) Key decisions made. " +
          "Be concise but preserve critical details.\n\n" +
          conversationText,
      },
    ],
    max_tokens: 2000,
  });

  const summary = response.content[0]?.text || "(no summary)";

  return [
    { role: "user", content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}` },
    { role: "assistant", content: "Understood. I have the context from the summary. Continuing." },
  ];
}

// =============================================================================
// Tool Handlers
// =============================================================================

function safe_path(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const relative = path.relative(WORKDIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(p)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function run_bash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const r = child_process.spawnSync(command, [], {
      cwd: WORKDIR,
      shell: true,
      timeout: 120 * 1000,
      encoding: "utf-8",
    });
    const out = (r.stdout + r.stderr).trim();
    return out ? out.slice(0, 50000) : "(no output)";
  } catch {
    return "Error: Timeout (120s)";
  }
}

function run_read(filePath: string, limit?: number): string {
  try {
    const lines = fs.readFileSync(safe_path(filePath), "utf-8").split("\n");
    if (limit && lines.length > limit) {
      lines.push(`... (${lines.length - limit} more)`);
    }
    return lines.join("\n").slice(0, 50000);
  } catch (e) {
    return `Error: ${e}`;
  }
}

function run_write(filePath: string, content: string): string {
  try {
    const fp = safe_path(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, { encoding: "utf-8" });
    return `Wrote ${content.length} bytes`;
  } catch (e) {
    return `Error: ${e}`;
  }
}

function run_edit(filePath: string, oldText: string, newText: string): string {
  try {
    const fp = safe_path(filePath);
    const c = fs.readFileSync(fp, "utf-8");
    if (!c.includes(oldText)) return `Error: Text not found in ${filePath}`;
    fs.writeFileSync(fp, c.replace(oldText, newText), { encoding: "utf-8" });
    return `Edited ${filePath}`;
  } catch (e) {
    return `Error: ${e}`;
  }
}

const TOOL_HANDLERS: Record<string, (p: Record<string, unknown>) => string> = {
  bash: (p) => run_bash(p["command"] as string),
  read_file: (p) => run_read(p["path"] as string, p["limit"] as number | undefined),
  write_file: (p) => run_write(p["path"] as string, p["content"] as string),
  edit_file: (p) => run_edit(p["path"] as string, p["old_text"] as string, p["new_text"] as string),
  compact: () => "Manual compression requested.",
};

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object" as const,
      properties: { command: { type: "string" as const } },
      required: ["command"] as const,
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string" as const }, limit: { type: "integer" as const } },
      required: ["path"] as const,
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string" as const }, content: { type: "string" as const } },
      required: ["path", "content"] as const,
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string" as const }, old_text: { type: "string" as const }, new_text: { type: "string" as const } },
      required: ["path", "old_text", "new_text"] as const,
    },
  },
  {
    name: "compact",
    description: "Trigger manual conversation compression.",
    input_schema: {
      type: "object" as const,
      properties: { focus: { type: "string" as const, description: "What to preserve in the summary" } },
    },
  },
];

// =============================================================================
// Type Definitions
// =============================================================================

type MessageRole = "user" | "assistant" | "system";

type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

type TextBlock = {
  type: "text";
  text: string;
};

type ContentBlock = ToolResultBlock | TextBlock;
type AssistantContentBlock = ToolUseBlock | TextBlock;

type MessageContent = string | ContentBlock[];

interface Message {
  role: MessageRole;
  content: MessageContent;
}

// =============================================================================
// Agent Loop
// =============================================================================

async function agent_loop(messages: Message[]): Promise<void> {
  while (true) {
    // 每次循环：先微压缩，再检查是否需要自动压缩
    micro_compact(messages);

    if (estimate_tokens(messages) > THRESHOLD) {
      console.log("[auto_compact triggered]");
      const compacted = await auto_compact(messages);
      messages.splice(0, messages.length, ...compacted);
    }

    const response: any = await client.messages.create({
      model: MODEL,
      messages: messages as any,
      tools: TOOLS as any,
      max_tokens: 8000,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: ContentBlock[] = [];
    let manualCompact = false;

    for (const block of response.content) {
      if (block.type === "tool_use") {
        let output: string;

        if (block.name === "compact") {
          manualCompact = true;
          output = "Compressing...";
        } else {
          const handler = TOOL_HANDLERS[block.name];
          try {
            output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
          } catch (e) {
            output = `Error: ${e}`;
          }
        }

        console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output),
        });
      }
    }

    messages.push({ role: "user", content: results });

    // Layer 3: 手动压缩 - 模型主动调用 compact 工具触发
    if (manualCompact) {
      console.log("[manual compact]");
      const compacted = await auto_compact(messages);
      messages.splice(0, messages.length, ...compacted);
    }
  }
}

// =============================================================================
// REPL
// =============================================================================

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "\x1b[36ms06 >> \x1b[0m",
});

const history: Message[] = [];

rl.prompt();

rl.on("line", async (line) => {
  const query = line.trim();

  if (query.toLowerCase() === "q" || query === "" || query.toLowerCase() === "exit") {
    rl.close();
    return;
  }

  history.push({ role: "user", content: query });
  await agent_loop(history);

  const responseContent = history[history.length - 1].content;
  if (Array.isArray(responseContent)) {
    for (const block of responseContent) {
      if (block.type === "text") {
        console.log(block.text);
      }
    }
  }
  console.log();
  rl.prompt();
});

rl.on("close", () => process.exit(0));

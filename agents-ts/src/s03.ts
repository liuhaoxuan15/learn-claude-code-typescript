#!/usr/bin/env node
/**
 * s03.ts - TodoWrite
 *
 * The model tracks its own progress via a TodoManager. A nag reminder
 * forces it to keep updating when it forgets.
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> | Tools   |
 *     |  prompt  |      |       |      | + todo  |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   tool_result |
 *                           +---------------+
 *                                 |
 *                    +-----------+-----------+
 *                    | TodoManager state     |
 *                    | [ ] task A            |
 *                    | [>] task B <- doing   |
 *                    | [x] task C            |
 *                    +-----------------------+
 *                                 |
 *                    if rounds_since_todo >= 3:
 *                      inject <reminder>
 *
 * Key insight: "The agent can track its own progress -- and I can see it."
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

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID || "claude-sonnet-4-6";

// =============================================================================
// TodoManager
// =============================================================================

interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

// TodoManager：验证规则 - 最多20项、只能一个 in_progress、状态必须合法
class TodoManager {
  private items: TodoItem[] = [];

  update(items: TodoItem[]): string {
    if (items.length > 20) throw new Error("Max 20 todos allowed");

    const validated: TodoItem[] = [];
    let inProgressCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const text = String(item.text || "").trim();
      const status = String(item.status || "pending").toLowerCase() as TodoItem["status"];
      const id = String(item.id || String(i + 1));

      if (!text) throw new Error(`Item ${id}: text required`);
      if (!["pending", "in_progress", "completed"].includes(status))
        throw new Error(`Item ${id}: invalid status '${status}'`);
      if (status === "in_progress") inProgressCount++;

      validated.push({ id, text, status });
    }

    if (inProgressCount > 1) throw new Error("Only one task can be in_progress at a time");

    this.items = validated;
    return this.render();
  }

  private render(): string {
    if (this.items.length === 0) return "No todos.";
    const lines: string[] = [];
    for (const item of this.items) {
      const marker =
        item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]";
      lines.push(`${marker} #${item.id}: ${item.text}`);
    }
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join("\n");
  }
}

const TODO = new TodoManager();

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

// =============================================================================
// Tool Dispatch Map
// =============================================================================

type ToolHandler = (params: Record<string, unknown>) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (p) => run_bash(p["command"] as string),
  read_file: (p) => run_read(p["path"] as string, p["limit"] as number | undefined),
  write_file: (p) => run_write(p["path"] as string, p["content"] as string),
  edit_file: (p) => run_edit(p["path"] as string, p["old_text"] as string, p["new_text"] as string),
  todo: (p) => TODO.update(p["items"] as TodoItem[]),
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
    name: "todo",
    description: "Update task list. Track progress on multi-step tasks.",
    input_schema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              id: { type: "string" as const },
              text: { type: "string" as const },
              status: { type: "string" as const, enum: ["pending", "in_progress", "completed"] as const },
            },
            required: ["id", "text", "status"] as const,
          },
        },
      },
      required: ["items"] as const,
    },
  },
];

// =============================================================================
// Type Definitions
// =============================================================================

type MessageRole = "user" | "assistant" | "system";

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

type MessageContent = string | ContentBlock[];

interface Message {
  role: MessageRole;
  content: MessageContent;
}

// =============================================================================
// Agent Loop with Nag Reminder
// =============================================================================

async function agent_loop(messages: Message[]): Promise<void> {
  let rounds_since_todo = 0;

  while (true) {
    const response = (await client.messages.create({
      model: MODEL,
      messages: messages as any,
      tools: TOOLS as any,
      max_tokens: 8000,
    })) as any;

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: ContentBlock[] = [];
    let used_todo = false;

    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        let output: string;
        try {
          output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
        } catch (e) {
          output = `Error: ${e}`;
        }
        console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output),
        });
        if (block.name === "todo") used_todo = true;
      }
    }

    // Nag reminder：如果连续 3 轮没有使用 todo 工具，注入提醒
    rounds_since_todo = used_todo ? 0 : rounds_since_todo + 1;
    if (rounds_since_todo >= 3) {
      results.unshift({ type: "text", text: "<reminder>Update your todos.</reminder>" } as TextBlock);
    }

    messages.push({ role: "user", content: results });
  }
}

// =============================================================================
// REPL
// =============================================================================

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "\x1b[36ms03 >> \x1b[0m",
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

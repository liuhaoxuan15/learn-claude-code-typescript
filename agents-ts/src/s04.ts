#!/usr/bin/env node
/**
 * s04.ts - Subagents
 *
 * Spawn a child agent with fresh messages=[]. The child works in its own
 * context, sharing the filesystem, then returns only a summary to the parent.
 *
 *     Parent agent                     Subagent
 *     +------------------+             +------------------+
 *     | messages=[...]   |             | messages=[]      |  <-- fresh
 *     |                  |  dispatch   |                  |
 *     | tool: task       | ---------->| while tool_use:  |
 *     |   prompt="..."   |            |   call tools     |
 *     |   description="" |            |   append results |
 *     |                  |  summary   |                  |
 *     |   result = "..." | <--------- | return last text |
 *     +------------------+             +------------------+
 *               |
 *     Parent context stays clean.
 *     Subagent context is discarded.
 *
 * Key insight: "Process isolation gives context isolation for free."
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

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use the task tool to delegate exploration or subtasks.`;
const SUBAGENT_SYSTEM = `You are a coding subagent at ${WORKDIR}. Complete the given task, then summarize your findings.`;

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
};

// =============================================================================
// Subagent
// =============================================================================

const CHILD_TOOLS = [
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
];

async function run_subagent(prompt: string): Promise<string> {
  const subMessages: { role: "user" | "assistant"; content: unknown }[] = [
    { role: "user", content: prompt },
  ];

  let response: any = null;

  for (let i = 0; i < 30; i++) {
    response = (await client.messages.create({
      model: MODEL,
      system: SUBAGENT_SYSTEM,
      messages: subMessages as any,
      tools: CHILD_TOOLS as any,
      max_tokens: 8000,
    })) as any;

    subMessages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") break;

    const results: { type: "tool_result"; tool_use_id: string; content: string }[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = TOOL_HANDLERS[block.name];
        const output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output).slice(0, 50000),
        });
      }
    }

    subMessages.push({ role: "user", content: results });
  }

  if (!response) return "(no response)";

  const texts = response.content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");

  return texts || "(no summary)";
}

// =============================================================================
// Parent Tools
// =============================================================================

const PARENT_TOOLS = [
  ...CHILD_TOOLS,
  {
    name: "task",
    description: "Spawn a subagent with fresh context. It shares the filesystem but not conversation history.",
    input_schema: {
      type: "object" as const,
      properties: {
        prompt: { type: "string" as const },
        description: { type: "string" as const, description: "Short description of the task" },
      },
      required: ["prompt"] as const,
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
// Agent Loop
// =============================================================================

async function agent_loop(messages: Message[]): Promise<void> {
  while (true) {
    const response = (await client.messages.create({
      model: MODEL,
      messages: messages as any,
      tools: PARENT_TOOLS as any,
      max_tokens: 8000,
    })) as any;

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: ContentBlock[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        let output: string;

        if (block.name === "task") {
          const desc = (block.input as { description?: string }).description || "subtask";
          console.log(`> task (${desc}): ${String((block.input as { prompt: string }).prompt).slice(0, 80)}`);
          output = await run_subagent((block.input as { prompt: string }).prompt);
        } else {
          const handler = TOOL_HANDLERS[block.name];
          output = handler ? handler(block.input) : `Unknown tool: ${block.name}`;
        }

        console.log(`  ${String(output).slice(0, 200)}`);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: String(output),
        });
      }
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
  prompt: "\x1b[36ms04 >> \x1b[0m",
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

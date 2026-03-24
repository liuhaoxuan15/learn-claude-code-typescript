#!/usr/bin/env node
/**
 * s07.ts - Tasks
 *
 * Tasks persist as JSON files in .tasks/ so they survive context compression.
 * Each task has a dependency graph (blockedBy/blocks).
 *
 *     .tasks/
 *       task_1.json  {"id":1, "subject":"...", "status":"completed", ...}
 *       task_2.json  {"id":2, "blockedBy":[1], "status":"pending", ...}
 *       task_3.json  {"id":3, "blockedBy":[2], "blocks":[], ...}
 *
 *     Dependency resolution:
 *     +----------+     +----------+     +----------+
 *     | task 1   | --> | task 2   | --> | task 3   |
 *     | complete |     | blocked  |     | blocked  |
 *     +----------+     +----------+     +----------+
 *          |                ^
 *          +--- completing task 1 removes it from task 2's blockedBy
 *
 * Key insight: "State that survives compression -- because it's outside the conversation."
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
const TASKS_DIR = path.join(WORKDIR, ".tasks");

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID || "claude-sonnet-4-6";

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

// =============================================================================
// TaskManager (文件持久化 + 依赖图)
// =============================================================================

// 任务结构：状态、依赖 (blockedBy/blocks)、负责人
interface Task {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  blockedBy: number[];
  blocks: number[];
  owner: string;
}

// 每个任务存储为 .tasks/task_{id}.json，实现进程间持久化
class TaskManager {
  private dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.nextId = this.maxId() + 1;
  }

  private maxId(): number {
    const files = fs.readdirSync(this.dir).filter((f) => f.startsWith("task_") && f.endsWith(".json"));
    if (files.length === 0) return 0;
    const ids = files.map((f) => parseInt(f.match(/task_(\d+)\.json/)?.[1] || "0"));
    return Math.max(...ids);
  }

  private load(taskId: number): Task {
    const p = path.join(this.dir, `task_${taskId}.json`);
    if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }

  private save(task: Task): void {
    fs.writeFileSync(
      path.join(this.dir, `task_${task.id}.json`),
      JSON.stringify(task, null, 2),
      { encoding: "utf-8" }
    );
  }

  // 任务完成时：从所有任务的 blockedBy 中移除它，自动解除依赖
  private clearDependency(completedId: number): void {
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      const task = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf-8"));
      if (task.blockedBy?.includes(completedId)) {
        task.blockedBy = task.blockedBy.filter((id: number) => id !== completedId);
        this.save(task);
      }
    }
  }

  create(subject: string, description = ""): string {
    const task: Task = {
      id: this.nextId,
      subject,
      description,
      status: "pending",
      blockedBy: [],
      blocks: [],
      owner: "",
    };
    this.save(task);
    this.nextId++;
    return JSON.stringify(task, null, 2);
  }

  get(taskId: number): string {
    return JSON.stringify(this.load(taskId), null, 2);
  }

  // update: 支持状态变更 + 添加 blockedBy/addBlocks（双向维护依赖关系）
  update(taskId: number, status?: string, addBlockedBy?: number[], addBlocks?: number[]): string {
    const task = this.load(taskId);

    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status as Task["status"];
      if (status === "completed") {
        this.clearDependency(taskId); // 自动解除对该任务的依赖
      }
    }

    if (addBlockedBy) {
      task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    }

    if (addBlocks) {
      task.blocks = [...new Set([...task.blocks, ...addBlocks])];
      for (const blockedId of addBlocks) {
        try {
          const blocked = this.load(blockedId);
          if (!blocked.blockedBy.includes(taskId)) {
            blocked.blockedBy.push(taskId);
            this.save(blocked);
          }
        } catch {
          // Task might not exist yet
        }
      }
    }

    this.save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll(): string {
    const tasks: Task[] = [];
    for (const f of fs.readdirSync(this.dir).sort()) {
      if (f.endsWith(".json")) {
        tasks.push(JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf-8")));
      }
    }

    if (tasks.length === 0) return "No tasks.";

    const lines: string[] = [];
    for (const t of tasks) {
      const marker = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
      const blocked = t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(", ")})` : "";
      lines.push(`${marker} #${t.id}: ${t.subject}${blocked}`);
    }
    return lines.join("\n");
  }
}

const TASKS = new TaskManager(TASKS_DIR);

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
  task_create: (p) => TASKS.create(p["subject"] as string, p["description"] as string | undefined),
  task_update: (p) => TASKS.update(p["task_id"] as number, p["status"] as string | undefined, p["addBlockedBy"] as number[] | undefined, p["addBlocks"] as number[] | undefined),
  task_list: () => TASKS.listAll(),
  task_get: (p) => TASKS.get(p["task_id"] as number),
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
    name: "task_create",
    description: "Create a new task.",
    input_schema: {
      type: "object" as const,
      properties: { subject: { type: "string" as const }, description: { type: "string" as const } },
      required: ["subject"] as const,
    },
  },
  {
    name: "task_update",
    description: "Update a task's status or dependencies.",
    input_schema: {
      type: "object" as const,
      properties: {
        task_id: { type: "integer" as const },
        status: { type: "string" as const, enum: ["pending", "in_progress", "completed"] as const },
        addBlockedBy: { type: "array" as const, items: { type: "integer" as const } },
        addBlocks: { type: "array" as const, items: { type: "integer" as const } },
      },
      required: ["task_id"] as const,
    },
  },
  {
    name: "task_list",
    description: "List all tasks with status summary.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "task_get",
    description: "Get full details of a task by ID.",
    input_schema: {
      type: "object" as const,
      properties: { task_id: { type: "integer" as const } },
      required: ["task_id"] as const,
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
  prompt: "\x1b[36ms07 >> \x1b[0m",
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

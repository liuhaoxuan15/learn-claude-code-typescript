#!/usr/bin/env node
/**
 * s09.ts - Agent Teams
 *
 * Persistent named agents with file-based JSONL inboxes. Each teammate runs
 * its own agent loop in a separate thread. Communication via append-only inboxes.
 *
 *     Subagent (s04):  spawn -> execute -> return summary -> destroyed
 *     Teammate (s09):  spawn -> work -> idle -> work -> ... -> shutdown
 *
 * Key insight: "Teammates that can talk to each other."
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
const TEAM_DIR = path.join(WORKDIR, ".team");
const INBOX_DIR = path.join(TEAM_DIR, "inbox");

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID || "claude-sonnet-4-6";

const SYSTEM = `You are a team lead at ${WORKDIR}. Spawn teammates and communicate via inboxes.`;

const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
]);

// =============================================================================
// MessageBus
// =============================================================================

interface Message {
  type: string;
  from: string;
  content: string;
  timestamp: number;
  [key: string]: unknown;
}

// MessageBus: 基于 JSONL 文件的异步消息队列，每个 teammate 一个收件箱文件
class MessageBus {
  private dir: string;

  constructor(inboxDir: string) {
    this.dir = inboxDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  // send: 追加消息到目标收件箱的 JSONL 文件
  send(sender: string, to: string, content: string, msgType = "message", extra?: Record<string, unknown>): string {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${Array.from(VALID_MSG_TYPES).join(", ")}`;
    }
    const msg: Message = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now(),
    };
    if (extra) Object.assign(msg, extra);
    const inboxPath = path.join(this.dir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n", { encoding: "utf-8" });
    return `Sent ${msgType} to ${to}`;
  }

  // readInbox: 读取并清空收件箱（消费模式）
  readInbox(name: string): Message[] {
    const inboxPath = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) return [];
    const content = fs.readFileSync(inboxPath, "utf-8").trim();
    if (!content) return [];
    const messages = content.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Message);
    fs.writeFileSync(inboxPath, "", { encoding: "utf-8" });
    return messages;
  }

  // broadcast: 向所有队友发送广播消息
  broadcast(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, "broadcast");
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

const BUS = new MessageBus(INBOX_DIR);

// =============================================================================
// TeammateManager
// =============================================================================

interface Member {
  name: string;
  role: string;
  status: "working" | "idle" | "shutdown";
}

interface TeamConfig {
  team_name: string;
  members: Member[];
}

class TeammateManager {
  private dir: string;
  private configPath: string;
  private config: TeamConfig;
  private threads: Map<string, { status: string }>;

  constructor(teamDir: string) {
    this.dir = teamDir;
    this.configPath = path.join(this.dir, "config.json");
    fs.mkdirSync(this.dir, { recursive: true });
    this.config = this.loadConfig();
    this.threads = new Map();
  }

  private loadConfig(): TeamConfig {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    }
    return { team_name: "default", members: [] };
  }

  private saveConfig(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), { encoding: "utf-8" });
  }

  private findMember(name: string): Member | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  // spawn: 创建持久化队友（非一次性），运行在独立线程中
  spawn(name: string, role: string, prompt: string): string {
    const member = this.findMember(name);
    if (member) {
      if (member.status !== "idle" && member.status !== "shutdown") {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      this.config.members.push({ name, role, status: "working" });
    }
    this.saveConfig();

    const threadInfo = { status: "running" };
    this.threads.set(name, threadInfo);

    setTimeout(() => {
      this.teammateLoop(name, role, prompt);
      threadInfo.status = "stopped";
    }, 0);

    return `Spawned '${name}' (role: ${role})`;
  }

  // teammateLoop: 队友独立循环 - 每次 LLM 调用前检查收件箱，支持 idle 状态保持
  private async teammateLoop(name: string, role: string, prompt: string): Promise<void> {
    const sysPrompt = `You are '${name}', role: ${role}, at ${WORKDIR}. Use send_message to communicate. Complete your task.`;
    const messages: { role: "user" | "assistant"; content: unknown }[] = [{ role: "user", content: prompt }];

    const tools = this.teammateTools();

    for (let i = 0; i < 50; i++) {
      const inbox = BUS.readInbox(name);
      for (const msg of inbox) {
        messages.push({ role: "user", content: JSON.stringify(msg) });
      }

      try {
        const response: any = await client.messages.create({
          model: MODEL,
          system: sysPrompt,
          messages: messages as any,
          tools: tools as any,
          max_tokens: 8000,
        });

        messages.push({ role: "assistant", content: response.content });

        if (response.stop_reason !== "tool_use") break;

        const results: { type: "tool_result"; tool_use_id: string; content: string }[] = [];

        for (const block of response.content) {
          if (block.type === "tool_use") {
            const output = this.exec(name, block.name, block.input);
            console.log(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}`);
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: String(output),
            });
          }
        }

        messages.push({ role: "user", content: results });
      } catch {
        break;
      }
    }

    const member = this.findMember(name);
    if (member && member.status !== "shutdown") {
      member.status = "idle";
      this.saveConfig();
    }
  }

  private exec(sender: string, toolName: string, args: Record<string, unknown>): string {
    if (toolName === "bash") return run_bash(args["command"] as string);
    if (toolName === "read_file") return run_read(args["path"] as string);
    if (toolName === "write_file") return run_write(args["path"] as string, args["content"] as string);
    if (toolName === "edit_file") return run_edit(args["path"] as string, args["old_text"] as string, args["new_text"] as string);
    if (toolName === "send_message") return BUS.send(sender, args["to"] as string, args["content"] as string, args["msg_type"] as string | undefined);
    if (toolName === "read_inbox") return JSON.stringify(BUS.readInbox(sender), null, 2);
    return `Unknown tool: ${toolName}`;
  }

  private teammateTools() {
    return [
      {
        name: "bash",
        description: "Run a shell command.",
        input_schema: { type: "object" as const, properties: { command: { type: "string" as const } }, required: ["command"] as const },
      },
      {
        name: "read_file",
        description: "Read file contents.",
        input_schema: { type: "object" as const, properties: { path: { type: "string" as const } }, required: ["path"] as const },
      },
      {
        name: "write_file",
        description: "Write content to file.",
        input_schema: { type: "object" as const, properties: { path: { type: "string" as const }, content: { type: "string" as const } }, required: ["path", "content"] as const },
      },
      {
        name: "edit_file",
        description: "Replace exact text in file.",
        input_schema: { type: "object" as const, properties: { path: { type: "string" as const }, old_text: { type: "string" as const }, new_text: { type: "string" as const } }, required: ["path", "old_text", "new_text"] as const },
      },
      {
        name: "send_message",
        description: "Send message to a teammate.",
        input_schema: { type: "object" as const, properties: { to: { type: "string" as const }, content: { type: "string" as const }, msg_type: { type: "string" as const } }, required: ["to", "content"] as const },
      },
      {
        name: "read_inbox",
        description: "Read and drain your inbox.",
        input_schema: { type: "object" as const, properties: {} },
      },
    ];
  }

  listAll(): string {
    if (this.config.members.length === 0) return "No teammates.";
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join("\n");
  }

  memberNames(): string[] {
    return this.config.members.map((m) => m.name);
  }
}

const TEAM = new TeammateManager(TEAM_DIR);

// =============================================================================
// Base Tools
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
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot"];
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
  spawn_teammate: (p) => TEAM.spawn(p["name"] as string, p["role"] as string, p["prompt"] as string),
  list_teammates: () => TEAM.listAll(),
  send_message: (p) => BUS.send("lead", p["to"] as string, p["content"] as string, p["msg_type"] as string | undefined),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: (p) => BUS.broadcast("lead", p["content"] as string, TEAM.memberNames()),
};

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: { type: "object" as const, properties: { command: { type: "string" as const } }, required: ["command"] as const },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" as const }, limit: { type: "integer" as const } }, required: ["path"] as const },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" as const }, content: { type: "string" as const } }, required: ["path", "content"] as const },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: { type: "object" as const, properties: { path: { type: "string" as const }, old_text: { type: "string" as const }, new_text: { type: "string" as const } }, required: ["path", "old_text", "new_text"] as const },
  },
  {
    name: "spawn_teammate",
    description: "Spawn a persistent teammate that runs in its own thread.",
    input_schema: { type: "object" as const, properties: { name: { type: "string" as const }, role: { type: "string" as const }, prompt: { type: "string" as const } }, required: ["name", "role", "prompt"] as const },
  },
  {
    name: "list_teammates",
    description: "List all teammates with name, role, status.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "send_message",
    description: "Send a message to a teammate's inbox.",
    input_schema: { type: "object" as const, properties: { to: { type: "string" as const }, content: { type: "string" as const }, msg_type: { type: "string" as const } }, required: ["to", "content"] as const },
  },
  {
    name: "read_inbox",
    description: "Read and drain the lead's inbox.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "broadcast",
    description: "Send a message to all teammates.",
    input_schema: { type: "object" as const, properties: { content: { type: "string" as const } }, required: ["content"] as const },
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

interface MessageItem {
  role: MessageRole;
  content: MessageContent;
}

// =============================================================================
// Agent Loop
// =============================================================================

// agent_loop: 主循环开始时先检查 lead 收件箱，注入队友消息
async function agent_loop(messages: MessageItem[]): Promise<void> {
  while (true) {
    const inbox = BUS.readInbox("lead");
    if (inbox.length > 0) {
      messages.push({
        role: "user",
        content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
      });
      messages.push({
        role: "assistant",
        content: "Noted inbox messages.",
      });
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
  prompt: "\x1b[36ms09 >> \x1b[0m",
});

const history: MessageItem[] = [];

rl.prompt();

rl.on("line", async (line) => {
  const query = line.trim();

  if (query.toLowerCase() === "q" || query === "" || query.toLowerCase() === "exit") {
    rl.close();
    return;
  }

  if (query === "/team") {
    console.log(TEAM.listAll());
    rl.prompt();
    return;
  }

  if (query === "/inbox") {
    console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
    rl.prompt();
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

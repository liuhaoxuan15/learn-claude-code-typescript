#!/usr/bin/env node
/**
 * s10.ts - 团队协议
 *
 * 关闭协议和计划审批协议，两者使用相同的 request_id 关联模式。
 * 构建在 s09 的团队消息之上。
 *
 *     关闭 FSM: pending -> approved | rejected
 *
 *     Lead                              Teammate
 *     +---------------------+          +---------------------+
 *     | shutdown_request     |          |                     |
 *     | {                    | -------> | receives request    |
 *     |   request_id: abc    |          | decides: approve?   |
 *     | }                    |          |                     |
 *     +---------------------+          +---------------------+
 *                                              |
 *     +---------------------+          +-------v-------------+
 *     | shutdown_response    | <------- | shutdown_response   |
 *     | {                    |          | {                   |
 *     |   request_id: abc    |          |   request_id: abc   |
 *     |   approve: true      |          |   approve: true     |
 *     | }                    |          | }                   |
 *     +---------------------+          +---------------------+
 *             |
 *             v
 *     status -> "shutdown", thread stops
 *
 *     计划审批 FSM: pending -> approved | rejected
 *
 *     Teammate                          Lead
 *     +---------------------+          +---------------------+
 *     | plan_approval        |          |                     |
 *     | submit: {plan:"..."}| -------> | reviews plan text   |
 *     +---------------------+          | approve/reject?     |
 *                                      +---------------------+
 *                                              |
 *     +---------------------+          +-------v-------------+
 *     | plan_approval_resp   | <------- | plan_approval       |
 *     | {approve: true}      |          | review: {req_id,    |
 *     +---------------------+          |   approve: true}     |
 *                                      +---------------------+
 *
 *     Trackers: {request_id: {"target|from": name, "status": "pending|..."}}
 *
 * Key insight: "Same request_id correlation pattern, two domains."
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as readline from "node:readline";
import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
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

const SYSTEM = `You are a team lead at ${WORKDIR}. Manage teammates with shutdown and plan approval protocols.`;

const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
]);

// =============================================================================
// 类型定义
// =============================================================================

type 消息角色 = "user" | "assistant" | "system";

interface 工具结果块 {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

interface 文本块 {
  type: "text";
  text: string;
}

type 内容块 = 工具结果块 | 文本块;

type 消息内容 = string | 内容块[];

interface 消息 {
  role: 消息角色;
  content: 消息内容;
}

interface 消息项 {
  type: "message" | "broadcast" | "shutdown_request" | "shutdown_response" | "plan_approval_response";
  from: string;
  content: string;
  timestamp: number;
  request_id?: string;
  approve?: boolean;
  [key: string]: unknown;
}

interface 团队成员 {
  name: string;
  role: string;
  status: "working" | "idle" | "shutdown";
}

interface 团队配置 {
  team_name: string;
  members: 团队成员[];
}

// =============================================================================
// 请求跟踪器
// =============================================================================

const 关闭请求表 = new Map<string, { target: string; status: string }>();
const 计划请求表 = new Map<string, { from: string; plan: string; status: string }>();
const 跟踪锁 = { _lock: false };

function 获得锁(): boolean {
  return true;
}

// =============================================================================
// MessageBus
// =============================================================================

class MessageBus {
  private dir: string;

  constructor(inboxDir: string) {
    this.dir = inboxDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  发送(sender: string, to: string, content: string, msgType = "message", extra?: Record<string, unknown>): string {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${Array.from(VALID_MSG_TYPES).join(", ")}`;
    }
    const msg: 消息项 = { type: msgType as 消息项["type"], from: sender, content, timestamp: Date.now() };
    if (extra) Object.assign(msg, extra);
    const inboxPath = path.join(this.dir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n", { encoding: "utf-8" });
    return `Sent ${msgType} to ${to}`;
  }

  读取收件箱(name: string): 消息项[] {
    const inboxPath = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) return [];
    const content = fs.readFileSync(inboxPath, "utf-8").trim();
    if (!content) return [];
    const messages = content.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as 消息项);
    fs.writeFileSync(inboxPath, "", { encoding: "utf-8" });
    return messages;
  }

  广播(sender: string, content: string, teammates: string[]): string {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.发送(sender, name, content, "broadcast");
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

class TeammateManager {
  private dir: string;
  private configPath: string;
  private config: 团队配置;
  private threads: Map<string, { status: string }>;

  constructor(teamDir: string) {
    this.dir = teamDir;
    this.configPath = path.join(this.dir, "config.json");
    fs.mkdirSync(this.dir, { recursive: true });
    this.config = this.#load();
    this.threads = new Map();
  }

  #load(): 团队配置 {
    if (fs.existsSync(this.configPath)) {
      return JSON.parse(fs.readFileSync(this.configPath, "utf-8"));
    }
    return { team_name: "default", members: [] };
  }

  #save(): void {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), { encoding: "utf-8" });
  }

  #findMember(name: string): 团队成员 | undefined {
    return this.config.members.find((m) => m.name === name);
  }

  生成(name: string, role: string, prompt: string): string {
    const member = this.#findMember(name);
    if (member) {
      if (member.status !== "idle" && member.status !== "shutdown") {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      this.config.members.push({ name, role, status: "working" });
    }
    this.#save();
    const threadInfo = { status: "running" };
    this.threads.set(name, threadInfo);

    setTimeout(() => {
      this.#teammateLoop(name, role, prompt);
      threadInfo.status = "stopped";
    }, 0);

    return `Spawned '${name}' (role: ${role})`;
  }

  #teammateLoop(name: string, role: string, prompt: string): void {
    const sysPrompt = (
      `You are '${name}', role: ${role}, at ${WORKDIR}. `
      + `Submit plans via plan_approval before major work. `
      + `Respond to shutdown_request with shutdown_response.`
    );
    const messages: 消息[] = [{ role: "user", content: prompt }];
    const tools = this.#teammateTools();
    let shouldExit = false;

    for (let i = 0; i < 50; i++) {
      const inbox = BUS.读取收件箱(name);
      for (const msg of inbox) {
        messages.push({ role: "user", content: JSON.stringify(msg) });
      }
      if (shouldExit) break;

      try {
        const response: any = client.messages.create({
          model: MODEL,
          system: sysPrompt,
          messages: messages as any,
          tools: tools as any,
          max_tokens: 8000,
        });

        messages.push({ role: "assistant", content: response.content });

        if (response.stop_reason !== "tool_use") break;

        const results: 工具结果块[] = [];

        for (const block of response.content) {
          if (block.type === "tool_use") {
            const output = this.#exec(name, block.name, block.input);
            console.log(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}`);
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: String(output),
            });
            if (block.name === "shutdown_response" && block.input.get?.("approve")) {
              shouldExit = true;
            }
          }
        }

        messages.push({ role: "user", content: results });
      } catch {
        break;
      }
    }

    const member = this.#findMember(name);
    if (member) {
      member.status = shouldExit ? "shutdown" : "idle";
      this.#save();
    }
  }

  #exec(sender: string, toolName: string, args: Record<string, unknown>): string {
    if (toolName === "bash") return 运行命令(args["command"] as string);
    if (toolName === "read_file") return 读取文件(args["path"] as string);
    if (toolName === "write_file") return 写入文件(args["path"] as string, args["content"] as string);
    if (toolName === "edit_file") return 编辑文件(args["path"] as string, args["old_text"] as string, args["new_text"] as string);
    if (toolName === "send_message") return BUS.发送(sender, args["to"] as string, args["content"] as string, args["msg_type"] as string | undefined);
    if (toolName === "read_inbox") return JSON.stringify(BUS.读取收件箱(sender), null, 2);
    if (toolName === "shutdown_response") {
      const reqId = args["request_id"] as string;
      const approve = args["approve"] as boolean;
      if (获得锁() && 关闭请求表.has(reqId)) {
        关闭请求表.set(reqId, { target: sender, status: approve ? "approved" : "rejected" });
      }
      BUS.发送(
        sender, "lead", (args["reason"] as string) || "",
        "shutdown_response", { request_id: reqId, approve },
      );
      return `Shutdown ${approve ? "approved" : "rejected"}`;
    }
    if (toolName === "plan_approval") {
      const planText = (args["plan"] as string) || "";
      const reqId = crypto.randomUUID().slice(0, 8);
      if (获得锁()) {
        计划请求表.set(reqId, { from: sender, plan: planText, status: "pending" });
      }
      BUS.发送(
        sender, "lead", planText, "plan_approval_response",
        { request_id: reqId, plan: planText },
      );
      return `Plan submitted (request_id=${reqId}). Waiting for lead approval.`;
    }
    return `Unknown tool: ${toolName}`;
  }

  #teammateTools() {
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
      {
        name: "shutdown_response",
        description: "Respond to a shutdown request. Approve to shut down, reject to keep working.",
        input_schema: { type: "object" as const, properties: { request_id: { type: "string" as const }, approve: { type: "boolean" as const }, reason: { type: "string" as const } }, required: ["request_id", "approve"] as const },
      },
      {
        name: "plan_approval",
        description: "Submit a plan for lead approval. Provide plan text.",
        input_schema: { type: "object" as const, properties: { plan: { type: "string" as const } }, required: ["plan"] as const },
      },
    ];
  }

  列出全部(): string {
    if (this.config.members.length === 0) return "No teammates.";
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join("\n");
  }

  成员名称(): string[] {
    return this.config.members.map((m) => m.name);
  }
}

const TEAM = new TeammateManager(TEAM_DIR);

// =============================================================================
// 基础工具函数
// =============================================================================

function 安全路径(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const relative = path.relative(WORKDIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(p)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function 运行命令(command: string): string {
  const 危险 = ["rm -rf /", "sudo", "shutdown", "reboot"];
  if (危险.some((d) => command.includes(d))) {
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

function 读取文件(filePath: string, limit?: number): string {
  try {
    const lines = fs.readFileSync(安全路径(filePath), "utf-8").split("\n");
    if (limit && lines.length > limit) {
      lines.push(`... (${lines.length - limit} more)`);
    }
    return lines.join("\n").slice(0, 50000);
  } catch (e) {
    return `Error: ${e}`;
  }
}

function 写入文件(filePath: string, content: string): string {
  try {
    const fp = 安全路径(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, { encoding: "utf-8" });
    return `Wrote ${content.length} bytes`;
  } catch (e) {
    return `Error: ${e}`;
  }
}

function 编辑文件(filePath: string, oldText: string, newText: string): string {
  try {
    const fp = 安全路径(filePath);
    const c = fs.readFileSync(fp, "utf-8");
    if (!c.includes(oldText)) return `Error: Text not found in ${filePath}`;
    fs.writeFileSync(fp, c.replace(oldText, newText), { encoding: "utf-8" });
    return `Edited ${filePath}`;
  } catch (e) {
    return `Error: ${e}`;
  }
}

// =============================================================================
// Lead 协议处理器
// =============================================================================

function 处理关闭请求(teammate: string): string {
  const reqId = crypto.randomUUID().slice(0, 8);
  if (获得锁()) {
    关闭请求表.set(reqId, { target: teammate, status: "pending" });
  }
  BUS.发送(
    "lead", teammate, "Please shut down gracefully.",
    "shutdown_request", { request_id: reqId },
  );
  return `Shutdown request ${reqId} sent to '${teammate}' (status: pending)`;
}

function 处理计划审核(requestId: string, approve: boolean, feedback = ""): string {
  const req = 计划请求表.get(requestId);
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;
  if (获得锁()) {
    req.status = approve ? "approved" : "rejected";
  }
  BUS.发送(
    "lead", req.from, feedback, "plan_approval_response",
    { request_id: requestId, approve, feedback },
  );
  return `Plan ${req.status} for '${req.from}'`;
}

function 检查关闭状态(requestId: string): string {
  if (获得锁()) {
    const entry = 关闭请求表.get(requestId);
    return JSON.stringify(entry || { error: "not found" });
  }
  return "{}";
}

// =============================================================================
// 工具处理器和定义 (Lead - 12 tools)
// =============================================================================

type 工具处理器 = (p: Record<string, unknown>) => string;

const 工具处理器映射: Record<string, 工具处理器> = {
  bash: (p) => 运行命令(p["command"] as string),
  read_file: (p) => 读取文件(p["path"] as string, p["limit"] as number | undefined),
  write_file: (p) => 写入文件(p["path"] as string, p["content"] as string),
  edit_file: (p) => 编辑文件(p["path"] as string, p["old_text"] as string, p["new_text"] as string),
  spawn_teammate: (p) => TEAM.生成(p["name"] as string, p["role"] as string, p["prompt"] as string),
  list_teammates: () => TEAM.列出全部(),
  send_message: (p) => BUS.发送("lead", p["to"] as string, p["content"] as string, p["msg_type"] as string | undefined),
  read_inbox: () => JSON.stringify(BUS.读取收件箱("lead"), null, 2),
  broadcast: (p) => BUS.广播("lead", p["content"] as string, TEAM.成员名称()),
  shutdown_request: (p) => 处理关闭请求(p["teammate"] as string),
  shutdown_response: (p) => 检查关闭状态(p["request_id"] as string),
  plan_approval: (p) => 处理计划审核(p["request_id"] as string, p["approve"] as boolean, p["feedback"] as string | undefined),
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
    description: "Spawn a persistent teammate.",
    input_schema: { type: "object" as const, properties: { name: { type: "string" as const }, role: { type: "string" as const }, prompt: { type: "string" as const } }, required: ["name", "role", "prompt"] as const },
  },
  {
    name: "list_teammates",
    description: "List all teammates.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "send_message",
    description: "Send a message to a teammate.",
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
  {
    name: "shutdown_request",
    description: "Request a teammate to shut down gracefully. Returns a request_id for tracking.",
    input_schema: { type: "object" as const, properties: { teammate: { type: "string" as const } }, required: ["teammate"] as const },
  },
  {
    name: "shutdown_response",
    description: "Check the status of a shutdown request by request_id.",
    input_schema: { type: "object" as const, properties: { request_id: { type: "string" as const } }, required: ["request_id"] as const },
  },
  {
    name: "plan_approval",
    description: "Approve or reject a teammate's plan. Provide request_id + approve + optional feedback.",
    input_schema: { type: "object" as const, properties: { request_id: { type: "string" as const }, approve: { type: "boolean" as const }, feedback: { type: "string" as const } }, required: ["request_id", "approve"] as const },
  },
];

// =============================================================================
// 主循环
// =============================================================================

async function 主循环(messages: 消息[]): Promise<void> {
  while (true) {
    const inbox = BUS.读取收件箱("lead");
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
      system: SYSTEM,
      messages: messages as any,
      tools: TOOLS as any,
      max_tokens: 8000,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      return;
    }

    const results: 内容块[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        const handler = 工具处理器映射[block.name];
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
  prompt: "\x1b[36ms10 >> \x1b[0m",
});

const 历史记录: 消息[] = [];

rl.prompt();

rl.on("line", async (line) => {
  const query = line.trim();

  if (query.toLowerCase() === "q" || query === "" || query.toLowerCase() === "exit") {
    rl.close();
    return;
  }

  if (query === "/team") {
    console.log(TEAM.列出全部());
    rl.prompt();
    return;
  }

  if (query === "/inbox") {
    console.log(JSON.stringify(BUS.读取收件箱("lead"), null, 2));
    rl.prompt();
    return;
  }

  历史记录.push({ role: "user", content: query });
  await 主循环(历史记录);

  const responseContent = 历史记录[历史记录.length - 1].content;
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

#!/usr/bin/env node
/**
 * s11.ts - 自主 Agent
 *
 * 空闲循环与任务板轮询，自动认领未分配任务，以及上下文压缩后的身份重新注入。
 * 构建在 s10 的协议之上。
 *
 *     Teammate lifecycle:
 *     +-------+
 *     | spawn |
 *     +---+---+
 *         |
 *         v
 *     +-------+  tool_use    +-------+
 *     | WORK  | <----------- |  LLM  |
 *     +---+---+              +-------+
 *         |
 *         | stop_reason != tool_use
 *         v
 *     +--------+
 *     | IDLE   | poll every 5s for up to 60s
 *     +---+----+
 *         |
 *         +---> check inbox -> message? -> resume WORK
 *         |
 *         +---> scan .tasks/ -> unclaimed? -> claim -> resume WORK
 *         |
 *         +---> timeout (60s) -> shutdown
 *
 *     Identity re-injection after compression:
 *     messages = [identity_block, ...remaining...]
 *     "You are 'coder', role: backend, team: my-team"
 *
 * Key insight: "The agent finds work itself."
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
const TASKS_DIR = path.join(WORKDIR, ".tasks");

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID || "claude-sonnet-4-6";

const POLL_INTERVAL = 5;
const IDLE_TIMEOUT = 60;

const SYSTEM = `You are a team lead at ${WORKDIR}. Teammates are autonomous -- they find work themselves.`;

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

interface 任务 {
  id: number;
  subject: string;
  description?: string;
  status: string;
  owner?: string;
  blockedBy?: number[];
}

// =============================================================================
// 请求跟踪器
// =============================================================================

const 关闭请求表 = new Map<string, { target: string; status: string }>();
const 计划请求表 = new Map<string, { from: string; plan: string; status: string }>();
const 跟踪锁 = { _lock: false };
const 认领锁 = { _lock: false };

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
// 任务板扫描 (自动认领未分配任务)
// =============================================================================

// 扫描未认领任务: 查找 status=pending 且无 owner 的任务
function 扫描未认领任务(): 任务[] {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const unclaimed: 任务[] = [];
  const entries = fs.readdirSync(TASKS_DIR);
  for (const f of entries.sort()) {
    const match = f.match(/^task_(\d+)\.json$/);
    if (!match) continue;
    try {
      const task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf-8")) as 任务;
      if (task.status === "pending" && !task.owner && (!task.blockedBy || task.blockedBy.length === 0)) {
        unclaimed.push(task);
      }
    } catch {
      // skip invalid files
    }
  }
  return unclaimed;
}

function 认领任务(taskId: number, owner: string): string {
  if (!获得锁()) return "Error: Could not acquire lock";
  const taskPath = path.join(TASKS_DIR, `task_${taskId}.json`);
  if (!fs.existsSync(taskPath)) return `Error: Task ${taskId} not found`;
  try {
    const task = JSON.parse(fs.readFileSync(taskPath, "utf-8")) as 任务;
    task.owner = owner;
    task.status = "in_progress";
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2), { encoding: "utf-8" });
    return `Claimed task #${taskId} for ${owner}`;
  } catch (e) {
    return `Error: ${e}`;
  }
}

// =============================================================================
// 身份重新注入
// =============================================================================

function 创建身份块(name: string, role: string, teamName: string): 消息 {
  return {
    role: "user",
    content: `<identity>You are '${name}', role: ${role}, team: ${teamName}. Continue your work.</identity>`,
  };
}

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

  #setStatus(name: string, status: 团队成员["status"]): void {
    const member = this.#findMember(name);
    if (member) {
      member.status = status;
      this.#save();
    }
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
      this.#loop(name, role, prompt);
      threadInfo.status = "stopped";
    }, 0);

    return `Spawned '${name}' (role: ${role})`;
  }

  #loop(name: string, role: string, prompt: string): void {
    const teamName = this.config.team_name;
    const sysPrompt = (
      `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. `
      + `Use idle tool when you have no more work. You will auto-claim new tasks.`
    );
    const messages: 消息[] = [{ role: "user", content: prompt }];
    const tools = this.#teammateTools();

    while (true) {
      // -- WORK PHASE --
      let shouldExit = false;
      for (let i = 0; i < 50; i++) {
        const inbox = BUS.读取收件箱(name);
        for (const msg of inbox) {
          if (msg.type === "shutdown_request") {
            this.#setStatus(name, "shutdown");
            return;
          }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        }

        try {
          const response: any = client.messages.create({
            model: MODEL,
            system: sysPrompt,
            messages: messages as any,
            tools: tools as any,
            max_tokens: 8000,
          });

          messages.push({ role: "assistant", content: response.content });

          if (response.stop_reason !== "tool_use") {
            shouldExit = true;
            break;
          }

          const results: 工具结果块[] = [];
          let idleRequested = false;

          for (const block of response.content) {
            if (block.type === "tool_use") {
              let output: string;
              if (block.name === "idle") {
                idleRequested = true;
                output = "Entering idle phase. Will poll for new tasks.";
              } else {
                output = this.#exec(name, block.name, block.input);
              }
              console.log(`  [${name}] ${block.name}: ${String(output).slice(0, 120)}`);
              results.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: String(output),
              });
            }
          }

          messages.push({ role: "user", content: results });
          if (idleRequested) break;
        } catch {
          this.#setStatus(name, "idle");
          return;
        }
      }

      // -- IDLE PHASE: 空闲轮询 --
      // 1. 检查收件箱 (shutdown_request 或新消息 -> 恢复工作)
      // 2. 扫描任务板 (有未认领任务 -> 自动认领并恢复工作)
      // 3. 超时 (60s) -> 关闭
      this.#setStatus(name, "idle");
      let resume = false;
      const polls = Math.floor(IDLE_TIMEOUT / Math.max(POLL_INTERVAL, 1));

      for (let i = 0; i < polls; i++) {
        // sleep is synchronous in Node.js for simplicity
        const start = Date.now();
        while (Date.now() - start < POLL_INTERVAL * 1000) {
          // busy wait
        }

        const inbox = BUS.读取收件箱(name);
        if (inbox.length > 0) {
          for (const msg of inbox) {
            if (msg.type === "shutdown_request") {
              this.#setStatus(name, "shutdown");
              return;
            }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          }
          resume = true;
          break;
        }

        const unclaimed = 扫描未认领任务();
        if (unclaimed.length > 0) {
          const task = unclaimed[0];
          认领任务(task.id, name);
          const taskPrompt = (
            `<auto-claimed>Task #${task.id}: ${task.subject}\n`
            + `${task.description || ""}</auto-claimed>`
          );
          // 上下文压缩后需要重新注入身份块
          if (messages.length <= 3) {
            messages.unshift(创建身份块(name, role, teamName));
            messages.splice(1, 0, { role: "assistant", content: `I am ${name}. Continuing.` });
          }
          messages.push({ role: "user", content: taskPrompt });
          messages.push({ role: "assistant", content: `Claimed task #${task.id}. Working on it.` });
          resume = true;
          break;
        }
      }

      if (!resume) {
        this.#setStatus(name, "shutdown");
        return;
      }
      this.#setStatus(name, "working");
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
      return `Plan submitted (request_id=${reqId}). Waiting for approval.`;
    }
    if (toolName === "claim_task") {
      return 认领任务(args["task_id"] as number, sender);
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
        description: "Respond to a shutdown request.",
        input_schema: { type: "object" as const, properties: { request_id: { type: "string" as const }, approve: { type: "boolean" as const }, reason: { type: "string" as const } }, required: ["request_id", "approve"] as const },
      },
      {
        name: "plan_approval",
        description: "Submit a plan for lead approval.",
        input_schema: { type: "object" as const, properties: { plan: { type: "string" as const } }, required: ["plan"] as const },
      },
      {
        name: "idle",
        description: "Signal that you have no more work. Enters idle polling phase.",
        input_schema: { type: "object" as const, properties: {} },
      },
      // idle 工具: 队友主动调用，从 WORK 阶段切换到 IDLE 阶段开始轮询
      {
        name: "claim_task",
        description: "Claim a task from the task board by ID.",
        input_schema: { type: "object" as const, properties: { task_id: { type: "integer" as const } }, required: ["task_id"] as const },
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
  return `Shutdown request ${reqId} sent to '${teammate}'`;
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
// 工具处理器和定义 (Lead - 14 tools)
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
  idle: () => "Lead does not idle.",
  claim_task: (p) => 认领任务(p["task_id"] as number, "lead"),
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
    description: "Spawn an autonomous teammate.",
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
    description: "Request a teammate to shut down.",
    input_schema: { type: "object" as const, properties: { teammate: { type: "string" as const } }, required: ["teammate"] as const },
  },
  {
    name: "shutdown_response",
    description: "Check shutdown request status.",
    input_schema: { type: "object" as const, properties: { request_id: { type: "string" as const } }, required: ["request_id"] as const },
  },
  {
    name: "plan_approval",
    description: "Approve or reject a teammate's plan.",
    input_schema: { type: "object" as const, properties: { request_id: { type: "string" as const }, approve: { type: "boolean" as const }, feedback: { type: "string" as const } }, required: ["request_id", "approve"] as const },
  },
  {
    name: "idle",
    description: "Enter idle state (for lead -- rarely used).",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "claim_task",
    description: "Claim a task from the board by ID.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "integer" as const } }, required: ["task_id"] as const },
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
  prompt: "\x1b[36ms11 >> \x1b[0m",
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

  if (query === "/tasks") {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    const entries = fs.readdirSync(TASKS_DIR).sort();
    for (const f of entries) {
      const match = f.match(/^task_(\d+)\.json$/);
      if (!match) continue;
      try {
        const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf-8")) as 任务;
        const marker = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
        const owner = t.owner ? ` @${t.owner}` : "";
        console.log(`  ${marker} #${t.id}: ${t.subject}${owner}`);
      } catch {
        // skip
      }
    }
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

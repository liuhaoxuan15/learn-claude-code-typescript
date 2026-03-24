#!/usr/bin/env node
/**
 * s_full.ts - 完整参考 Agent（中文命名版）
 *
 * Capstone 实现：整合 s01-s11 所有机制的完整 Agent。
 * s12（task-aware worktree isolation）单独教学。
 */

// =============================================================================
// 导入
// =============================================================================

import * as path from "node:path";
import * as fs from "node:fs";
import * as readline from "node:readline";
import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { EventEmitter } from "node:events";
import { Anthropic } from "@anthropic-ai/sdk";

// =============================================================================
// 初始化
// =============================================================================

config({ override: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const 工作目录 = path.resolve(__dirname, "..", "..");

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});
const 模型 = process.env.MODEL_ID || "claude-sonnet-4-6";

const 团队目录 = path.join(工作目录, ".team");
const 收件箱目录 = path.join(团队目录, "inbox");
const 任务目录 = path.join(工作目录, ".tasks");
const 技能目录 = path.join(工作目录, "skills");
const 转录目录 = path.join(工作目录, ".transcripts");

const 令牌阈值 = 100000;
const 轮询间隔秒 = 5;
const 空闲超时秒 = 60;

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

type 响应块 = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

interface 任务 {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  owner: string | null;
  blockedBy: number[];
  blocks: number[];
}

interface 待办项 {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

interface 后台任务 {
  id: string;
  status: "running" | "completed" | "error";
  command: string;
  result: string | null;
}

interface 通知项 {
  task_id: string;
  status: string;
  result: string;
}

interface 消息项 {
  type: "message" | "broadcast" | "shutdown_request" | "shutdown_response" | "plan_approval_response";
  from: string;
  content: string;
  timestamp: number;
  request_id?: string;
  approve?: boolean;
  feedback?: string;
}

interface 团队成员 {
  name: string;
  role: string;
  status: "working" | "idle" | "shutdown";
}

type 工具处理器 = (params: Record<string, unknown>) => string | Promise<string>;

// =============================================================================
// 基础工具函数
// =============================================================================

function 安全路径(p: string): string {
  const resolved = path.resolve(工作目录, p);
  const relative = path.relative(工作目录, resolved);
  if (relative.startsWith("..") || path.isAbsolute(p)) {
    throw new Error(`路径超出工作目录: ${p}`);
  }
  return resolved;
}

function 运行命令(command: string): string {
  const 危险 = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (危险.some((d) => command.includes(d))) return "错误: 危险命令被阻止";
  try {
    const r = child_process.spawnSync(command, [], {
      cwd: 工作目录,
      shell: true,
      timeout: 120 * 1000,
      encoding: "utf-8",
    });
    const out = (r.stdout + r.stderr).trim();
    return out ? out.slice(0, 50000) : "(无输出)";
  } catch {
    return "错误: 命令超时 (120s)";
  }
}

function 读取文件(filePath: string, limit?: number): string {
  try {
    const lines = fs.readFileSync(安全路径(filePath), "utf-8").split("\n");
    if (limit && lines.length > limit) {
      lines.push(`... (还有 ${lines.length - limit} 行)`);
    }
    return lines.join("\n").slice(0, 50000);
  } catch (e) {
    return `错误: ${e}`;
  }
}

function 写入文件(filePath: string, content: string): string {
  try {
    const fp = 安全路径(filePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, { encoding: "utf-8" });
    return `写入 ${content.length} 字节到 ${filePath}`;
  } catch (e) {
    return `错误: ${e}`;
  }
}

function 编辑文件(filePath: string, oldText: string, newText: string): string {
  try {
    const fp = 安全路径(filePath);
    const c = fs.readFileSync(fp, "utf-8");
    if (!c.includes(oldText)) return `错误: 未在 ${filePath} 中找到指定文本`;
    // @ts-expect-error overload resolution edge case
    const newContent = c.replace(oldText, newText, 1);
    fs.writeFileSync(fp, newContent, { encoding: "utf-8" });
    return `已编辑 ${filePath}`;
  } catch (e) {
    return `错误: ${e}`;
  }
}

// =============================================================================
// 待办管理器 (s03)
// =============================================================================

class TodoManager {
  private items: 待办项[] = [];

  更新(items: 待办项[]): string {
    const validated: 待办项[] = [];
    let inProgress = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const content = String(item.content || "").trim();
      const status = String(item.status || "pending").toLowerCase() as 待办项["status"];
      const activeForm = String(item.activeForm || "").trim();
      if (!content) throw new Error(`第 ${i} 项: content 是必填项`);
      if (!["pending", "in_progress", "completed"].includes(status))
        throw new Error(`第 ${i} 项: 无效状态 '${status}'`);
      if (!activeForm) throw new Error(`第 ${i} 项: activeForm 是必填项`);
      if (status === "in_progress") inProgress++;
      validated.push({ content, status, activeForm });
    }
    if (validated.length > 20) throw new Error("最多 20 个待办项");
    if (inProgress > 1) throw new Error("只能有一个 in_progress 项");
    this.items = validated;
    return this.#渲染();
  }

  #渲染(): string {
    if (this.items.length === 0) return "无待办事项。";
    const lines: string[] = [];
    for (const item of this.items) {
      const marker = item.status === "completed" ? "[x]" : item.status === "in_progress" ? "[>]" : "[ ]";
      const suffix = item.status === "in_progress" ? ` <- ${item.activeForm}` : "";
      lines.push(`${marker} ${item.content}${suffix}`);
    }
    const done = this.items.filter((t) => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} 已完成)`);
    return lines.join("\n");
  }

  有待处理项(): boolean {
    return this.items.some((item) => item.status !== "completed");
  }
}

// =============================================================================
// 子代理 (s04)
// =============================================================================

async function 运行子代理(prompt: string, agentType = "Explore"): Promise<string> {
  const 子工具: any[] = [
    { name: "bash", description: "运行命令", input_schema: { type: "object" as const, properties: { command: { type: "string" as const } }, required: ["command"] as const } },
    { name: "read_file", description: "读取文件", input_schema: { type: "object" as const, properties: { path: { type: "string" as const } }, required: ["path"] as const } },
  ];
  if (agentType !== "Explore") {
    子工具.push(
      { name: "write_file", description: "写入文件", input_schema: { type: "object" as const, properties: { path: { type: "string" as const }, content: { type: "string" as const } }, required: ["path", "content"] as const } },
      { name: "edit_file", description: "编辑文件", input_schema: { type: "object" as const, properties: { path: { type: "string" as const }, old_text: { type: "string" as const }, new_text: { type: "string" as const } }, required: ["path", "old_text", "new_text"] as const } }
    );
  }

  const 子处理器: Record<string, 工具处理器> = {
    bash: (p) => 运行命令(p["command"] as string),
    read_file: (p) => 读取文件(p["path"] as string),
    write_file: (p) => 写入文件(p["path"] as string, p["content"] as string),
    edit_file: (p) => 编辑文件(p["path"] as string, p["old_text"] as string, p["new_text"] as string),
  };

  const 子消息: 消息[] = [{ role: "user", content: prompt }];
  let resp: { content: 响应块[]; stop_reason: string } | null = null;

  for (let i = 0; i < 30; i++) {
    resp = (await client.messages.create({
      model: 模型,
      messages: 子消息 as any,
      tools: 子工具 as any,
      max_tokens: 8000,
    })) as any;
    子消息.push({ role: "assistant", content: resp!.content as any });
    if (resp!.stop_reason !== "tool_use") break;
    const results: 工具结果块[] = [];
    for (const block of resp!.content) {
      if (block.type === "tool_use") {
        const h = 子处理器[block.name] || (() => "未知工具");
        results.push({ type: "tool_result", tool_use_id: block.id, content: String(h(block.input)).slice(0, 50000) });
      }
    }
    子消息.push({ role: "user", content: results });
  }

  if (resp) {
    return resp.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("") || "(无摘要)";
  }
  return "(子代理失败)";
}

// =============================================================================
// 技能加载器 (s05)
// =============================================================================

class SkillLoader {
  private skills = new Map<string, { meta: Record<string, string>; body: string }>();

  constructor(skillsDir: string) {
    if (!fs.existsSync(skillsDir)) return;
    const self = this;
    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const md = path.join(full, "SKILL.md");
          if (fs.existsSync(md)) self.#loadFile(md, path.basename(full));
          else walk(full);
        }
      }
    }
    walk(skillsDir);
  }

  #loadFile(filePath: string, defaultName: string) {
    const text = fs.readFileSync(filePath, "utf-8");
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    let meta: Record<string, string> = {};
    let body = text;
    if (match) {
      for (const line of match[1].trim().split("\n")) {
        const idx = line.indexOf(":");
        if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
      body = match[2].trim();
    }
    this.skills.set(meta["name"] || defaultName, { meta, body });
  }

  获取描述列表(): string {
    if (this.skills.size === 0) return "(无技能)";
    const lines: string[] = [];
    for (const [name, skill] of this.skills) {
      lines.push(`  - ${name}: ${skill.meta["description"] || "-"}`);
    }
    return lines.join("\n");
  }

  加载(name: string): string {
    const skill = this.skills.get(name);
    if (!skill) return `错误: 未知技能 '${name}'。可用: ${Array.from(this.skills.keys()).join(", ")}`;
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

// =============================================================================
// 上下文压缩 (s06)
// =============================================================================

function 估算令牌数(messages: 消息[]): number {
  return JSON.stringify(messages).length / 4;
}

function 微压缩(messages: 消息[]) {
  const toolResults: 工具结果块[] = [];
  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "object" && part !== null && (part as 工具结果块).type === "tool_result") {
          toolResults.push(part as 工具结果块);
        }
      }
    }
  }
  if (toolResults.length <= 3) return;
  for (const part of toolResults.slice(0, -3)) {
    if (typeof part.content === "string" && part.content.length > 100) {
      part.content = "[已清理]";
    }
  }
}

async function 自动压缩(messages: 消息[]): Promise<消息[]> {
  fs.mkdirSync(转录目录, { recursive: true });
  const p = path.join(转录目录, `transcript_${Date.now()}.jsonl`);
  fs.writeFileSync(p, messages.map((m) => JSON.stringify(m)).join("\n"), { encoding: "utf-8" });
  const convText = JSON.stringify(messages).slice(0, 80000);
  const resp = (await client.messages.create({
    model: 模型,
    messages: [{ role: "user", content: `请为连续性总结以下对话:\n${convText}` }],
    max_tokens: 2000,
  })) as any;
  const summary = resp.content?.[0]?.text || "(无摘要)";
  return [
    { role: "user", content: `[已压缩。转录文件: ${p}]\n${summary}` },
    { role: "assistant", content: "收到。继续在摘要上下文中工作。" },
  ];
}

// =============================================================================
// 任务管理器 (s07)
// =============================================================================

class TaskManager {
  constructor() {
    fs.mkdirSync(任务目录, { recursive: true });
  }

  #nextId(): number {
    const ids: number[] = [];
    for (const f of fs.readdirSync(任务目录)) {
      const m = f.match(/^task_(\d+)\.json$/);
      if (m) ids.push(parseInt(m[1]));
    }
    return ids.length > 0 ? Math.max(...ids) + 1 : 1;
  }

  #load(tid: number): 任务 {
    const p = path.join(任务目录, `task_${tid}.json`);
    if (!fs.existsSync(p)) throw new Error(`任务 ${tid} 不存在`);
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }

  #save(task: 任务) {
    fs.writeFileSync(path.join(任务目录, `task_${task.id}.json`), JSON.stringify(task, null, 2), { encoding: "utf-8" });
  }

  创建(subject: string, description = ""): string {
    const task: 任务 = { id: this.#nextId(), subject, description, status: "pending", owner: null, blockedBy: [], blocks: [] };
    this.#save(task);
    return JSON.stringify(task, null, 2);
  }

  获取(tid: number): string {
    return JSON.stringify(this.#load(tid), null, 2);
  }

  更新(tid: number, status?: string, addBlockedBy?: number[], addBlocks?: number[]): string {
    const task = this.#load(tid);
    if (status) {
      task.status = status as 任务["status"];
      if (status === "completed") {
        for (const f of fs.readdirSync(任务目录)) {
          if (!f.endsWith(".json")) continue;
          const t = JSON.parse(fs.readFileSync(path.join(任务目录, f), "utf-8"));
          if (t.blockedBy?.includes(tid)) {
            t.blockedBy = t.blockedBy.filter((id: number) => id !== tid);
            this.#save(t);
          }
        }
      }
      if (status === "deleted") {
        fs.unlinkSync(path.join(任务目录, `task_${tid}.json`));
        return `任务 ${tid} 已删除`;
      }
    }
    if (addBlockedBy) task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    if (addBlocks) task.blocks = [...new Set([...task.blocks, ...addBlocks])];
    this.#save(task);
    return JSON.stringify(task, null, 2);
  }

  列出全部(): string {
    const tasks: 任务[] = [];
    for (const f of fs.readdirSync(任务目录)) {
      if (f.endsWith(".json")) tasks.push(JSON.parse(fs.readFileSync(path.join(任务目录, f), "utf-8")));
    }
    if (tasks.length === 0) return "无任务。";
    tasks.sort((a, b) => a.id - b.id);
    const lines: string[] = [];
    for (const t of tasks) {
      const marker = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
      const owner = t.owner ? ` @${t.owner}` : "";
      const blocked = t.blockedBy?.length ? ` (被 #${t.blockedBy.join(", #")} 阻塞)` : "";
      lines.push(`${marker} #${t.id}: ${t.subject}${owner}${blocked}`);
    }
    return lines.join("\n");
  }

  认领(tid: number, owner: string): string {
    const task = this.#load(tid);
    task.owner = owner;
    task.status = "in_progress";
    this.#save(task);
    return `已认领任务 #${tid} 给 ${owner}`;
  }
}

// =============================================================================
// 后台任务管理器 (s08)
// =============================================================================

class BackgroundManager {
  private 任务映射 = new Map<string, 后台任务>();
  private 通知队列: 通知项[] = [];

  运行(command: string, timeout = 120): string {
    const id = crypto.randomUUID().slice(0, 8);
    this.任务映射.set(id, { id, status: "running", command, result: null });
    const child = child_process.spawn(command, [], { cwd: 工作目录, shell: true, timeout: timeout * 1000 });
    let output = "";
    child.stdout?.on("data", (d) => { output += d.toString(); });
    child.stderr?.on("data", (d) => { output += d.toString(); });
    const self = this;
    child.on("close", (code) => {
      const status = code === 0 ? "completed" : "error";
      self.任务映射.set(id, { id, status, command, result: output.trim().slice(0, 50000) || "(无输出)" });
      self.通知队列.push({ task_id: id, status, result: output.trim().slice(0, 500) || "(无输出)" });
    });
    child.on("error", (err) => {
      self.任务映射.set(id, { id, status: "error", command, result: String(err) });
      self.通知队列.push({ task_id: id, status: "error", result: String(err).slice(0, 500) });
    });
    return `后台任务 ${id} 已启动: ${command.slice(0, 80)}`;
  }

  检查(tid?: string): string {
    if (tid) {
      const t = this.任务映射.get(tid);
      return t ? `[${t.status}] ${t.result || "(运行中)"}` : `未知: ${tid}`;
    }
    const lines: string[] = [];
    for (const [k, v] of this.任务映射) lines.push(`${k}: [${v.status}] ${v.command.slice(0, 60)}`);
    return lines.join("\n") || "无后台任务。";
  }

  消耗(): 通知项[] {
    const n = [...this.通知队列];
    this.通知队列 = [];
    return n;
  }
}

// =============================================================================
// 消息总线 (s09)
// =============================================================================

class MessageBus {
  constructor() {
    fs.mkdirSync(收件箱目录, { recursive: true });
  }

  发送(sender: string, to: string, content: string, msgType = "message", extra?: Record<string, unknown>): string {
    const msg: 消息项 = { type: msgType as 消息项["type"], from: sender, content, timestamp: Date.now() };
    if (extra) Object.assign(msg, extra);
    fs.appendFileSync(path.join(收件箱目录, `${to}.jsonl`), JSON.stringify(msg) + "\n", "utf-8");
    return `已发送 ${msgType} 给 ${to}`;
  }

  读取收件箱(name: string): 消息项[] {
    const p = path.join(收件箱目录, `${name}.jsonl`);
    if (!fs.existsSync(p)) return [];
    const content = fs.readFileSync(p, "utf-8").trim();
    if (!content) return [];
    const msgs = content.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as 消息项);
    fs.writeFileSync(p, "", { encoding: "utf-8" });
    return msgs;
  }

  广播(sender: string, content: string, names: string[]): string {
    let count = 0;
    for (const n of names) {
      if (n !== sender) { this.发送(sender, n, content, "broadcast"); count++; }
    }
    return `广播给 ${count} 个队友`;
  }
}

// =============================================================================
// 关闭与计划跟踪 (s10)
// =============================================================================

const 关闭请求表 = new Map<string, { target: string; status: string }>();
const 计划请求表 = new Map<string, { from: string; status: string }>();

function 处理关闭请求(teammate: string): string {
  const reqId = crypto.randomUUID().slice(0, 8);
  关闭请求表.set(reqId, { target: teammate, status: "pending" });
  return `关闭请求 ${reqId} 已发送给 '${teammate}'`;
}

function 处理计划审核(requestId: string, approve: boolean, feedback = ""): string {
  const req = 计划请求表.get(requestId);
  if (!req) return `错误: 未知计划请求 ID '${requestId}'`;
  req.status = approve ? "approved" : "rejected";
  return `计划已${approve ? "批准" : "拒绝"} for '${req.from}'`;
}

// =============================================================================
// 队友管理器 (s09/s11)
// =============================================================================

class TeammateManager {
  private 总线: MessageBus;
  private 任务管理: TaskManager;
  private 配置路径: string;
  private 配置: { team_name: string; members: 团队成员[] };

  constructor(bus: MessageBus, taskMgr: TaskManager) {
    fs.mkdirSync(团队目录, { recursive: true });
    this.总线 = bus;
    this.任务管理 = taskMgr;
    this.配置路径 = path.join(团队目录, "config.json");
    this.配置 = this.#load();
  }

  #load(): { team_name: string; members: 团队成员[] } {
    if (fs.existsSync(this.配置路径)) return JSON.parse(fs.readFileSync(this.配置路径, "utf-8"));
    return { team_name: "default", members: [] };
  }

  #save() {
    fs.writeFileSync(this.配置路径, JSON.stringify(this.配置, null, 2), { encoding: "utf-8" });
  }

  #查找(name: string): 团队成员 | undefined {
    return this.配置.members.find((m) => m.name === name);
  }

  #设置状态(name: string, status: 团队成员["status"]) {
    const m = this.#查找(name);
    if (m) { m.status = status; this.#save(); }
  }

  生成(name: string, role: string, prompt: string): string {
    const member = this.#查找(name);
    if (member) {
      if (member.status !== "idle" && member.status !== "shutdown") return `错误: '${name}' 当前状态为 ${member.status}`;
      member.status = "working";
      member.role = role;
    } else {
      this.配置.members.push({ name, role, status: "working" });
    }
    this.#save();
    return `已生成 '${name}' (角色: ${role})`;
  }

  列出全部(): string {
    if (this.配置.members.length === 0) return "无队友。";
    const lines = [`团队: ${this.配置.team_name}`];
    for (const m of this.配置.members) lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    return lines.join("\n");
  }

  成员名称(): string[] {
    return this.配置.members.map((m) => m.name);
  }
}

// =============================================================================
// 全局实例
// =============================================================================

const 待办实例 = new TodoManager();
const 技能实例 = new SkillLoader(技能目录);
const 任务管理实例 = new TaskManager();
const 后台实例 = new BackgroundManager();
const 消息实例 = new MessageBus();
const 团队实例 = new TeammateManager(消息实例, 任务管理实例);

// =============================================================================
// 系统提示
// =============================================================================

const 系统提示 = `你是 ${工作目录} 的编程 Agent。使用工具完成任务。
多步骤工作时优先使用 task_create/task_update/task_list。待办列表用于短期检查清单。
使用 task 委托子代理。使用 load_skill 加载专门知识。
可用技能:\n${技能实例.获取描述列表()}`;

// =============================================================================
// 工具处理器和定义
// =============================================================================

const 工具处理器映射: Record<string, 工具处理器> = {
  bash: (p) => 运行命令(p["command"] as string),
  read_file: (p) => 读取文件(p["path"] as string, p["limit"] as number | undefined),
  write_file: (p) => 写入文件(p["path"] as string, p["content"] as string),
  edit_file: (p) => 编辑文件(p["path"] as string, p["old_text"] as string, p["new_text"] as string),
  TodoWrite: (p) => 待办实例.更新(p["items"] as 待办项[]),
  task: async (p) => 运行子代理(p["prompt"] as string, p["agent_type"] as string | undefined),
  load_skill: (p) => 技能实例.加载(p["name"] as string),
  compress: () => "压缩中...",
  background_run: (p) => 后台实例.运行(p["command"] as string, p["timeout"] as number | undefined),
  check_background: (p) => 后台实例.检查(p["task_id"] as string | undefined),
  task_create: (p) => 任务管理实例.创建(p["subject"] as string, p["description"] as string | undefined),
  task_get: (p) => 任务管理实例.获取(p["task_id"] as number),
  task_update: (p) => 任务管理实例.更新(p["task_id"] as number, p["status"] as string | undefined, p["add_blocked_by"] as number[] | undefined, p["add_blocks"] as number[] | undefined),
  task_list: () => 任务管理实例.列出全部(),
  spawn_teammate: (p) => 团队实例.生成(p["name"] as string, p["role"] as string, p["prompt"] as string),
  list_teammates: () => 团队实例.列出全部(),
  send_message: (p) => 消息实例.发送("lead", p["to"] as string, p["content"] as string, p["msg_type"] as string | undefined),
  read_inbox: () => JSON.stringify(消息实例.读取收件箱("lead"), null, 2),
  broadcast: (p) => 消息实例.广播("lead", p["content"] as string, 团队实例.成员名称()),
  shutdown_request: (p) => 处理关闭请求(p["teammate"] as string),
  plan_approval: (p) => 处理计划审核(p["request_id"] as string, p["approve"] as boolean, p["feedback"] as string | undefined),
  idle: () => "Lead 不空闲。",
  claim_task: (p) => 任务管理实例.认领(p["task_id"] as number, "lead"),
};

const 工具定义列表 = [
  { name: "bash", description: "运行 shell 命令", input_schema: { type: "object" as const, properties: { command: { type: "string" as const } }, required: ["command"] as const } },
  { name: "read_file", description: "读取文件内容", input_schema: { type: "object" as const, properties: { path: { type: "string" as const }, limit: { type: "integer" as const } }, required: ["path"] as const } },
  { name: "write_file", description: "写入文件内容", input_schema: { type: "object" as const, properties: { path: { type: "string" as const }, content: { type: "string" as const } }, required: ["path", "content"] as const } },
  { name: "edit_file", description: "替换文件中的精确文本", input_schema: { type: "object" as const, properties: { path: { type: "string" as const }, old_text: { type: "string" as const }, new_text: { type: "string" as const } }, required: ["path", "old_text", "new_text"] as const } },
  { name: "TodoWrite", description: "更新任务跟踪列表", input_schema: { type: "object" as const, properties: { items: { type: "array" as const, items: { type: "object" as const, properties: { content: { type: "string" as const }, status: { type: "string" as const, enum: ["pending", "in_progress", "completed"] as const }, activeForm: { type: "string" as const } }, required: ["content", "status", "activeForm"] as const } } }, required: ["items"] as const } },
  { name: "task", description: "生成子代理进行隔离探索或工作", input_schema: { type: "object" as const, properties: { prompt: { type: "string" as const }, agent_type: { type: "string" as const, enum: ["Explore", "general-purpose"] as const } }, required: ["prompt"] as const } },
  { name: "load_skill", description: "按名称加载专门知识", input_schema: { type: "object" as const, properties: { name: { type: "string" as const } }, required: ["name"] as const } },
  { name: "compress", description: "手动压缩对话上下文", input_schema: { type: "object" as const, properties: {} } },
  { name: "background_run", description: "在后台运行命令", input_schema: { type: "object" as const, properties: { command: { type: "string" as const }, timeout: { type: "integer" as const } }, required: ["command"] as const } },
  { name: "check_background", description: "检查后台任务状态", input_schema: { type: "object" as const, properties: { task_id: { type: "string" as const } } } },
  { name: "task_create", description: "创建持久化文件任务", input_schema: { type: "object" as const, properties: { subject: { type: "string" as const }, description: { type: "string" as const } }, required: ["subject"] as const } },
  { name: "task_get", description: "通过 ID 获取任务详情", input_schema: { type: "object" as const, properties: { task_id: { type: "integer" as const } }, required: ["task_id"] as const } },
  { name: "task_update", description: "更新任务状态或依赖", input_schema: { type: "object" as const, properties: { task_id: { type: "integer" as const }, status: { type: "string" as const, enum: ["pending", "in_progress", "completed", "deleted"] as const }, add_blocked_by: { type: "array" as const, items: { type: "integer" as const } }, add_blocks: { type: "array" as const, items: { type: "integer" as const } } }, required: ["task_id"] as const } },
  { name: "task_list", description: "列出所有任务", input_schema: { type: "object" as const, properties: {} } },
  { name: "spawn_teammate", description: "生成持久化自主队友", input_schema: { type: "object" as const, properties: { name: { type: "string" as const }, role: { type: "string" as const }, prompt: { type: "string" as const } }, required: ["name", "role", "prompt"] as const } },
  { name: "list_teammates", description: "列出所有队友", input_schema: { type: "object" as const, properties: {} } },
  { name: "send_message", description: "发送消息给队友", input_schema: { type: "object" as const, properties: { to: { type: "string" as const }, content: { type: "string" as const }, msg_type: { type: "string" as const } }, required: ["to", "content"] as const } },
  { name: "read_inbox", description: "读取并清空 lead 的收件箱", input_schema: { type: "object" as const, properties: {} } },
  { name: "broadcast", description: "向所有队友发送广播", input_schema: { type: "object" as const, properties: { content: { type: "string" as const } }, required: ["content"] as const } },
  { name: "shutdown_request", description: "请求队友关闭", input_schema: { type: "object" as const, properties: { teammate: { type: "string" as const } }, required: ["teammate"] as const } },
  { name: "plan_approval", description: "批准或拒绝队友的计划", input_schema: { type: "object" as const, properties: { request_id: { type: "string" as const }, approve: { type: "boolean" as const }, feedback: { type: "string" as const } }, required: ["request_id", "approve"] as const } },
  { name: "idle", description: "进入空闲状态", input_schema: { type: "object" as const, properties: {} } },
  { name: "claim_task", description: "从任务板认领任务", input_schema: { type: "object" as const, properties: { task_id: { type: "integer" as const } }, required: ["task_id"] as const } },
];

// =============================================================================
// 主循环
// =============================================================================

async function 主循环(messages: 消息[]): Promise<void> {
  let 未使用待办轮数 = 0;

  while (true) {
    微压缩(messages);

    if (估算令牌数(messages) > 令牌阈值) {
      console.log("[自动压缩已触发]");
      messages = await 自动压缩(messages);
    }

    const 通知列表 = 后台实例.消耗();
    if (通知列表.length > 0) {
      const txt = 通知列表.map((n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join("\n");
      messages.push({ role: "user", content: `<background-results>\n${txt}\n</background-results>` });
      messages.push({ role: "assistant", content: "收到后台结果。" });
    }

    const 收件箱 = 消息实例.读取收件箱("lead");
    if (收件箱.length > 0) {
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(收件箱, null, 2)}</inbox>` });
      messages.push({ role: "assistant", content: "收到收件箱消息。" });
    }

    const resp = (await client.messages.create({
      model: 模型,
      system: 系统提示,
      messages: messages as any,
      tools: 工具定义列表 as any,
      max_tokens: 8000,
    })) as any;

    messages.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason !== "tool_use") return;

    const results: 内容块[] = [];
    let 使用了待办 = false;
    let 手动压缩 = false;

    for (const block of resp.content) {
      if (block.type === "tool_use") {
        if (block.name === "compress") 手动压缩 = true;
        const handler = 工具处理器映射[block.name];
        try {
          const output = handler ? await handler(block.input) : `未知工具: ${block.name}`;
          console.log(`> ${block.name}: ${String(output).slice(0, 200)}`);
          results.push({ type: "tool_result", tool_use_id: block.id, content: String(output) });
          if (block.name === "TodoWrite") 使用了待办 = true;
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: block.id, content: `错误: ${e}` });
        }
      }
    }

    未使用待办轮数 = 使用了待办 ? 0 : 未使用待办轮数 + 1;
    if (待办实例.有待处理项() && 未使用待办轮数 >= 3) {
      results.unshift({ type: "text", text: "<reminder>请更新你的待办列表。</reminder>" } as 文本块);
    }

    messages.push({ role: "user", content: results });

    if (手动压缩) {
      console.log("[手动压缩]");
      messages = await 自动压缩(messages);
    }
  }
}

// =============================================================================
// REPL
// =============================================================================

function 启动REPL() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "\x1b[36ms_full >> \x1b[0m",
  });

  const 历史记录: 消息[] = [];

  rl.prompt();

  rl.on("line", async (line) => {
    const query = line.trim();

    if (query.toLowerCase() === "q" || query === "" || query.toLowerCase() === "exit") {
      rl.close();
      return;
    }

    if (query === "/compact") {
      if (历史记录.length > 0) {
        console.log("[通过 /compact 手动压缩]");
        历史记录.splice(0, 历史记录.length, ...(await 自动压缩(历史记录)));
      }
      rl.prompt();
      return;
    }
    if (query === "/tasks") { console.log(任务管理实例.列出全部()); rl.prompt(); return; }
    if (query === "/team") { console.log(团队实例.列出全部()); rl.prompt(); return; }
    if (query === "/inbox") { console.log(JSON.stringify(消息实例.读取收件箱("lead"), null, 2)); rl.prompt(); return; }

    历史记录.push({ role: "user", content: query });
    await 主循环(历史记录);
    console.log();
    rl.prompt();
  });

  rl.on("close", () => process.exit(0));
}

启动REPL();

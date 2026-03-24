#!/usr/bin/env node
/**
 * s12.ts - Worktree + Task Isolation
 *
 * 目录级隔离用于并行任务执行。
 * 任务是控制平面，工作树是执行平面。
 *
 *     .tasks/task_12.json
 *       {
 *         "id": 12,
 *         "subject": "Implement auth refactor",
 *         "status": "in_progress",
 *         "worktree": "auth-refactor"
 *       }
 *
 *     .worktrees/index.json
 *       {
 *         "worktrees": [
 *           {
 *             "name": "auth-refactor",
 *             "path": ".../.worktrees/auth-refactor",
 *             "branch": "wt/auth-refactor",
 *             "task_id": 12,
 *             "status": "active"
 *           }
 *         ]
 *       }
 *
 * Key insight: "Isolate by directory, coordinate by task ID."
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

// =============================================================================
// 检测 git 仓库根目录 (worktree 需要 git 仓库)
// =============================================================================

// 检测仓库根: 使用 git rev-parse --show-toplevel 查找 git 仓库根目录
function 检测仓库根(cwd: string): string | null {
  try {
    const r = child_process.spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: 10 * 1000,
      encoding: "utf-8",
    });
    if (r.status !== 0) return null;
    const root = r.stdout.trim();
    return fs.existsSync(root) ? root : null;
  } catch {
    return null;
  }
}

const REPO_ROOT = 检测仓库根(WORKDIR) || WORKDIR;

const SYSTEM = (
  `You are a coding agent at ${WORKDIR}. `
  + "Use task + worktree tools for multi-task work. "
  + "For parallel or risky changes: create tasks, allocate worktree lanes, "
  + "run commands in those lanes, then choose keep/remove for closeout. "
  + "Use worktree_events when you need lifecycle visibility."
);

// =============================================================================
// EventBus
// =============================================================================

interface 事件项 {
  event: string;
  ts: number;
  task?: { id?: number };
  worktree?: Record<string, unknown>;
  error?: string;
  [key: string]: unknown;
}

class EventBus {
  private 路径: string;

  constructor(eventLogPath: string) {
    this.路径 = eventLogPath;
    fs.mkdirSync(path.dirname(this.路径), { recursive: true });
    if (!fs.existsSync(this.路径)) {
      fs.writeFileSync(this.路径, "", { encoding: "utf-8" });
    }
  }

  发送事件(
    event: string,
    task?: { id?: number },
    worktree?: Record<string, unknown>,
    error?: string,
  ): void {
    const payload: 事件项 = {
      event,
      ts: Date.now(),
      task: task || {},
      worktree: worktree || {},
    };
    if (error) payload.error = error;
    fs.appendFileSync(this.路径, JSON.stringify(payload) + "\n", { encoding: "utf-8" });
  }

  列出最近(limit = 20): string {
    const n = Math.max(1, Math.min(Number(limit) || 20, 200));
    const lines = fs.readFileSync(this.路径, "utf-8").split("\n").filter((l) => l.trim());
    const recent = lines.slice(-n);
    const items: 事件项[] = [];
    for (const line of recent) {
      try {
        items.push(JSON.parse(line) as 事件项);
      } catch {
        items.push({ event: "parse_error", raw: line, ts: 0 });
      }
    }
    return JSON.stringify(items, null, 2);
  }
}

// =============================================================================
// TaskManager
// =============================================================================

interface 任务 {
  id: number;
  subject: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
  owner: string;
  worktree: string;
  blockedBy: number[];
  created_at: number;
  updated_at: number;
}

class TaskManager {
  private dir: string;
  private nextId: number;

  constructor(tasksDir: string) {
    this.dir = tasksDir;
    fs.mkdirSync(this.dir, { recursive: true });
    this.nextId = this.#maxId() + 1;
  }

  #maxId(): number {
    const ids: number[] = [];
    for (const f of fs.readdirSync(this.dir)) {
      const match = f.match(/^task_(\d+)\.json$/);
      if (match) ids.push(parseInt(match[1]));
    }
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  #路径(taskId: number): string {
    return path.join(this.dir, `task_${taskId}.json`);
  }

  #加载(taskId: number): 任务 {
    const p = this.#路径(taskId);
    if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
    return JSON.parse(fs.readFileSync(p, "utf-8")) as 任务;
  }

  #保存(task: 任务): void {
    fs.writeFileSync(this.#路径(task.id), JSON.stringify(task, null, 2), { encoding: "utf-8" });
  }

  创建(subject: string, description = ""): string {
    const task: 任务 = {
      id: this.nextId,
      subject,
      description,
      status: "pending",
      owner: "",
      worktree: "",
      blockedBy: [],
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    this.#保存(task);
    this.nextId++;
    return JSON.stringify(task, null, 2);
  }

  获取(taskId: number): string {
    return JSON.stringify(this.#加载(taskId), null, 2);
  }

  存在(taskId: number): boolean {
    return fs.existsSync(this.#路径(taskId));
  }

  更新(taskId: number, status?: string, owner?: string): string {
    const task = this.#加载(taskId);
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status as 任务["status"];
    }
    if (owner !== undefined) task.owner = owner;
    task.updated_at = Date.now();
    this.#保存(task);
    return JSON.stringify(task, null, 2);
  }

  绑定工作树(taskId: number, worktree: string, owner = ""): string {
    const task = this.#加载(taskId);
    task.worktree = worktree;
    if (owner) task.owner = owner;
    if (task.status === "pending") task.status = "in_progress";
    task.updated_at = Date.now();
    this.#保存(task);
    return JSON.stringify(task, null, 2);
  }

  解绑工作树(taskId: number): string {
    const task = this.#加载(taskId);
    task.worktree = "";
    task.updated_at = Date.now();
    this.#保存(task);
    return JSON.stringify(task, null, 2);
  }

  列出全部(): string {
    const tasks: 任务[] = [];
    for (const f of fs.readdirSync(this.dir).sort()) {
      const match = f.match(/^task_(\d+)\.json$/);
      if (!match) continue;
      try {
        tasks.push(JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf-8")) as 任务);
      } catch {
        // skip
      }
    }
    if (tasks.length === 0) return "No tasks.";
    const lines: string[] = [];
    for (const t of tasks) {
      const marker = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
      const owner = t.owner ? ` owner=${t.owner}` : "";
      const wt = t.worktree ? ` wt=${t.worktree}` : "";
      lines.push(`${marker} #${t.id}: ${t.subject}${owner}${wt}`);
    }
    return lines.join("\n");
  }
}

// =============================================================================
// WorktreeManager (git worktree 生命周期管理)
// =============================================================================

// WorktreeEntry: 记录每个 worktree 的元数据，持久化到 .worktrees/index.json
interface WorktreeEntry {
  name: string;
  path: string;
  branch: string;
  task_id: number | null;
  status: string;
  created_at?: number;
  removed_at?: number;
  kept_at?: number;
}

interface WorktreeIndex {
  worktrees: WorktreeEntry[];
}

class WorktreeManager {
  private repoRoot: string;
  private tasks: TaskManager;
  private events: EventBus;
  private dir: string;
  private indexPath: string;
  private gitAvailable: boolean;

  constructor(repoRoot: string, tasks: TaskManager, events: EventBus) {
    this.repoRoot = repoRoot;
    this.tasks = tasks;
    this.events = events;
    this.dir = path.join(repoRoot, ".worktrees");
    this.indexPath = path.join(this.dir, "index.json");
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2), { encoding: "utf-8" });
    }
    this.gitAvailable = this.#isGitRepo();
  }

  #isGitRepo(): boolean {
    try {
      const r = child_process.spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: this.repoRoot,
        timeout: 10 * 1000,
        encoding: "utf-8",
      });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  #runGit(args: string[]): string {
    if (!this.gitAvailable) throw new Error("Not in a git repository. worktree tools require git.");
    const r = child_process.spawnSync("git", args, {
      cwd: this.repoRoot,
      timeout: 120 * 1000,
      encoding: "utf-8",
    });
    if (r.status !== 0) {
      const msg = (r.stdout + r.stderr).trim();
      throw new Error(msg || `git ${args.join(" ")} failed`);
    }
    return (r.stdout + r.stderr).trim() || "(no output)";
  }

  #loadIndex(): WorktreeIndex {
    return JSON.parse(fs.readFileSync(this.indexPath, "utf-8")) as WorktreeIndex;
  }

  #saveIndex(data: WorktreeIndex): void {
    fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2), { encoding: "utf-8" });
  }

  #find(name: string): WorktreeEntry | undefined {
    const idx = this.#loadIndex();
    return idx.worktrees.find((wt) => wt.name === name);
  }

  #validateName(name: string): void {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name || "")) {
      throw new Error("Invalid worktree name. Use 1-40 chars: letters, numbers, ., _, -");
    }
  }

  // 创建 worktree: 验证名称 -> 发送 before 事件 -> 执行 git worktree add -> 更新 index -> 绑定任务 -> 发送 after 事件
  创建(name: string, taskId?: number, baseRef = "HEAD"): string {
    this.#validateName(name);
    if (this.#find(name)) throw new Error(`Worktree '${name}' already exists in index`);
    if (taskId !== undefined && !this.tasks.存在(taskId)) throw new Error(`Task ${taskId} not found`);

    const worktreePath = path.join(this.dir, name);
    const branch = `wt/${name}`;

    this.events.发送事件(
      "worktree.create.before",
      taskId !== undefined ? { id: taskId } : undefined,
      { name, base_ref: baseRef },
    );

    try {
      this.#runGit(["worktree", "add", "-b", branch, worktreePath, baseRef]);

      const entry: WorktreeEntry = {
        name,
        path: worktreePath,
        branch,
        task_id: taskId ?? null,
        status: "active",
        created_at: Date.now(),
      };

      const idx = this.#loadIndex();
      idx.worktrees.push(entry);
      this.#saveIndex(idx);

      if (taskId !== undefined) {
        this.tasks.绑定工作树(taskId, name);
      }

      this.events.发送事件(
        "worktree.create.after",
        taskId !== undefined ? { id: taskId } : undefined,
        { name, path: worktreePath, branch, status: "active" },
      );

      return JSON.stringify(entry, null, 2);
    } catch (e) {
      this.events.发送事件(
        "worktree.create.failed",
        taskId !== undefined ? { id: taskId } : undefined,
        { name, base_ref: baseRef },
        String(e),
      );
      throw e;
    }
  }

  列出全部(): string {
    const idx = this.#loadIndex();
    const wts = idx.worktrees;
    if (wts.length === 0) return "No worktrees in index.";
    const lines: string[] = [];
    for (const wt of wts) {
      const suffix = wt.task_id !== null ? ` task=${wt.task_id}` : "";
      lines.push(`[${wt.status || "unknown"}] ${wt.name} -> ${wt.path} (${wt.branch || "-"})${suffix}`);
    }
    return lines.join("\n");
  }

  状态(name: string): string {
    const wt = this.#find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    const p = wt.path;
    if (!fs.existsSync(p)) return `Error: Worktree path missing: ${p}`;
    try {
      const r = child_process.spawnSync("git", ["status", "--short", "--branch"], {
        cwd: p,
        timeout: 60 * 1000,
        encoding: "utf-8",
      });
      const text = (r.stdout + r.stderr).trim();
      return text || "Clean worktree";
    } catch {
      return "Clean worktree";
    }
  }

  运行(name: string, command: string): string {
    const 危险 = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (危险.some((d) => command.includes(d))) return "Error: Dangerous command blocked";

    const wt = this.#find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;
    const p = wt.path;
    if (!fs.existsSync(p)) return `Error: Worktree path missing: ${p}`;

    try {
      const r = child_process.spawnSync(command, [], {
        cwd: p,
        shell: true,
        timeout: 300 * 1000,
        encoding: "utf-8",
      });
      const out = (r.stdout + r.stderr).trim();
      return out ? out.slice(0, 50000) : "(no output)";
    } catch {
      return "Error: Timeout (300s)";
    }
  }

  // 删除 worktree: 发送 before 事件 -> 执行 git worktree remove -> 可选完成任务 -> 更新 index -> 发送 after 事件
  删除(name: string, force = false, completeTask = false): string {
    const wt = this.#find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;

    this.events.发送事件(
      "worktree.remove.before",
      wt.task_id !== null ? { id: wt.task_id } : undefined,
      { name, path: wt.path },
    );

    try {
      const args = ["worktree", "remove"];
      if (force) args.push("--force");
      args.push(wt.path);
      this.#runGit(args);

      if (completeTask && wt.task_id !== null) {
        const taskId = wt.task_id;
        const before = JSON.parse(this.tasks.获取(taskId));
        this.tasks.更新(taskId, "completed");
        this.tasks.解绑工作树(taskId);
        this.events.发送事件(
          "task.completed",
          { id: taskId },
          { name },
        );
      }

      const idx = this.#loadIndex();
      for (const item of idx.worktrees) {
        if (item.name === name) {
          item.status = "removed";
          (item as WorktreeEntry & { removed_at: number }).removed_at = Date.now();
        }
      }
      this.#saveIndex(idx);

      this.events.发送事件(
        "worktree.remove.after",
        wt.task_id !== null ? { id: wt.task_id } : undefined,
        { name, path: wt.path, status: "removed" },
      );

      return `Removed worktree '${name}'`;
    } catch (e) {
      this.events.发送事件(
        "worktree.remove.failed",
        wt.task_id !== null ? { id: wt.task_id } : undefined,
        { name, path: wt.path },
        String(e),
      );
      throw e;
    }
  }

  // 保留 worktree: 标记为 "kept" 状态，不删除但记录生命周期状态
  保留(name: string): string {
    const wt = this.#find(name);
    if (!wt) return `Error: Unknown worktree '${name}'`;

    const idx = this.#loadIndex();
    let kept: WorktreeEntry | null = null;
    for (const item of idx.worktrees) {
      if (item.name === name) {
        item.status = "kept";
        (item as WorktreeEntry & { kept_at: number }).kept_at = Date.now();
        kept = item;
      }
    }
    this.#saveIndex(idx);

    this.events.发送事件(
      "worktree.keep",
      wt.task_id !== null ? { id: wt.task_id } : undefined,
      { name, path: wt.path, status: "kept" },
    );

    return kept ? JSON.stringify(kept, null, 2) : `Error: Unknown worktree '${name}'`;
  }
}

// =============================================================================
// 全局实例
// =============================================================================

const TASKS = new TaskManager(path.join(REPO_ROOT, ".tasks"));
const EVENTS = new EventBus(path.join(REPO_ROOT, ".worktrees", "events.jsonl"));
const WORKTREES = new WorktreeManager(REPO_ROOT, TASKS, EVENTS);

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
  const 危险 = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (危险.some((d) => command.includes(d))) return "Error: Dangerous command blocked";
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
// 工具处理器和定义 (17 tools)
// =============================================================================

type 工具处理器 = (p: Record<string, unknown>) => string;

const 工具处理器映射: Record<string, 工具处理器> = {
  bash: (p) => 运行命令(p["command"] as string),
  read_file: (p) => 读取文件(p["path"] as string, p["limit"] as number | undefined),
  write_file: (p) => 写入文件(p["path"] as string, p["content"] as string),
  edit_file: (p) => 编辑文件(p["path"] as string, p["old_text"] as string, p["new_text"] as string),
  task_create: (p) => TASKS.创建(p["subject"] as string, p["description"] as string | undefined),
  task_list: () => TASKS.列出全部(),
  task_get: (p) => TASKS.获取(p["task_id"] as number),
  task_update: (p) => TASKS.更新(p["task_id"] as number, p["status"] as string | undefined, p["owner"] as string | undefined),
  task_bind_worktree: (p) => TASKS.绑定工作树(p["task_id"] as number, p["worktree"] as string, p["owner"] as string | undefined),
  worktree_create: (p) => WORKTREES.创建(p["name"] as string, p["task_id"] as number | undefined, p["base_ref"] as string | undefined),
  worktree_list: () => WORKTREES.列出全部(),
  worktree_status: (p) => WORKTREES.状态(p["name"] as string),
  worktree_run: (p) => WORKTREES.运行(p["name"] as string, p["command"] as string),
  worktree_keep: (p) => WORKTREES.保留(p["name"] as string),
  worktree_remove: (p) => WORKTREES.删除(p["name"] as string, p["force"] as boolean | undefined, p["complete_task"] as boolean | undefined),
  worktree_events: (p) => EVENTS.列出最近(p["limit"] as number | undefined),
};

const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command in the current workspace (blocking).",
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
    name: "task_create",
    description: "Create a new task on the shared task board.",
    input_schema: { type: "object" as const, properties: { subject: { type: "string" as const }, description: { type: "string" as const } }, required: ["subject"] as const },
  },
  {
    name: "task_list",
    description: "List all tasks with status, owner, and worktree binding.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "task_get",
    description: "Get task details by ID.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "integer" as const } }, required: ["task_id"] as const },
  },
  {
    name: "task_update",
    description: "Update task status or owner.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "integer" as const }, status: { type: "string" as const, enum: ["pending", "in_progress", "completed"] as const }, owner: { type: "string" as const } }, required: ["task_id"] as const },
  },
  {
    name: "task_bind_worktree",
    description: "Bind a task to a worktree name.",
    input_schema: { type: "object" as const, properties: { task_id: { type: "integer" as const }, worktree: { type: "string" as const }, owner: { type: "string" as const } }, required: ["task_id", "worktree"] as const },
  },
  {
    name: "worktree_create",
    description: "Create a git worktree and optionally bind it to a task.",
    input_schema: { type: "object" as const, properties: { name: { type: "string" as const }, task_id: { type: "integer" as const }, base_ref: { type: "string" as const } }, required: ["name"] as const },
  },
  {
    name: "worktree_list",
    description: "List worktrees tracked in .worktrees/index.json.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "worktree_status",
    description: "Show git status for one worktree.",
    input_schema: { type: "object" as const, properties: { name: { type: "string" as const } }, required: ["name"] as const },
  },
  {
    name: "worktree_run",
    description: "Run a shell command in a named worktree directory.",
    input_schema: { type: "object" as const, properties: { name: { type: "string" as const }, command: { type: "string" as const } }, required: ["name", "command"] as const },
  },
  {
    name: "worktree_remove",
    description: "Remove a worktree and optionally mark its bound task completed.",
    input_schema: { type: "object" as const, properties: { name: { type: "string" as const }, force: { type: "boolean" as const }, complete_task: { type: "boolean" as const } }, required: ["name"] as const },
  },
  {
    name: "worktree_keep",
    description: "Mark a worktree as kept in lifecycle state without removing it.",
    input_schema: { type: "object" as const, properties: { name: { type: "string" as const } }, required: ["name"] as const },
  },
  {
    name: "worktree_events",
    description: "List recent worktree/task lifecycle events from .worktrees/events.jsonl.",
    input_schema: { type: "object" as const, properties: { limit: { type: "integer" as const } } },
  },
];

// =============================================================================
// 主循环
// =============================================================================

async function 主循环(messages: 消息[]): Promise<void> {
  while (true) {
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
  prompt: "\x1b[36ms12 >> \x1b[0m",
});

console.log(`Repo root for s12: ${REPO_ROOT}`);
if (!WORKTREES["gitAvailable"]) {
  console.log("Note: Not in a git repo. worktree_* tools will return errors.");
}

const 历史记录: 消息[] = [];

rl.prompt();

rl.on("line", async (line) => {
  const query = line.trim();

  if (query.toLowerCase() === "q" || query === "" || query.toLowerCase() === "exit") {
    rl.close();
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

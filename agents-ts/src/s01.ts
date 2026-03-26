#!/usr/bin/env node
/**
 * s01.ts - The Agent Loop
 *
 * The entire secret of an AI coding agent in one pattern:
 *
 *     while stop_reason == "tool_use":
 *         response = LLM(messages, tools)
 *         execute tools
 *         append results
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> |  Tool   |
 *     |  prompt  |      |       |      | execute |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   tool_result |
 *                           +---------------+
 *                           (loop continues)
 *
 * This is the core loop: feed tool results back to the model
 * until the model decides to stop. Production agents layer
 * policy, hooks, and lifecycle controls on top.
 */

import * as readline from "node:readline";
import * as child_process from "node:child_process";
import { config } from "dotenv";
import { Anthropic } from "@anthropic-ai/sdk";

config({ override: true });

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
});
console.log(client)

const MODEL = process.env.MODEL_ID || "claude-sonnet-4-6";

// =============================================================================
// Tool Definition & Handler
// =============================================================================

// 工具定义：告诉 LLM 有哪些工具可用，input_schema 必须与实际函数参数匹配
const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string" as const },
      },
      required: ["command"] as const,
    },
  },
];

// 工具执行函数：危险命令检查 + 同步执行 + 超时处理
function run_bash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const r = child_process.spawnSync(command, [], {
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

type ResponseBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

// =============================================================================
// The Core Pattern: Agent Loop
// =============================================================================

// 核心不变式 (Invariant): 这个循环结构在所有 session (s01-s12) 中保持不变
// 1. 调用 LLM  2. 检查 stop_reason  3. 执行工具  4. 追加结果形成闭环
async function agent_loop(messages: Message[]): Promise<void> {
  while (true) {
    // Step 1: 调用 LLM，传入消息历史和可用工具
    const response = (await client.messages.create({
      model: MODEL,
      messages: messages as any,
      tools: TOOLS as any,
      max_tokens: 8000,
    })) as any;

    messages.push({ role: "assistant", content: response.content });

    // Step 2: 检查 stop_reason，如果不是 "tool_use" 说明 Agent 已完成任务
    if (response.stop_reason !== "tool_use") {
      return;
    }

    // Step 3: 遍历工具调用，执行并收集结果
    const results: ContentBlock[] = [];

    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(`\x1b[33m$ ${(block.input as { command: string }).command}\x1b[0m`);
        const output = run_bash((block.input as { command: string }).command);
        console.log(output.slice(0, 200));
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    // Step 4: 将工具结果作为新用户消息追加，形成闭环，等待下一轮 LLM 调用
    messages.push({ role: "user", content: results });
  }
}

// =============================================================================
// REPL
// =============================================================================

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "\x1b[36ms01 >> \x1b[0m",
});

const history: Message[] = [];

rl.prompt();

// REPL: 读取用户输入 -> 调用 agent_loop -> 打印最终文本回复
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
  rl.prompt();
});

rl.on("close", () => process.exit(0));

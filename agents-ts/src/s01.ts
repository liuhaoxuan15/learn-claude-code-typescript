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

const MODEL = process.env.MODEL_ID || "claude-sonnet-4-6";

// =============================================================================
// Tool Definition & Handler
// =============================================================================

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

async function agent_loop(messages: Message[]): Promise<void> {
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

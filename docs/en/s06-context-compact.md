# s06: Context Compact

`s01 > s02 > s03 > s04 > s05 > [ s06 ] | s07 > s08 > s09 > s10 > s11 > s12`

> *"Context will fill up; you need a way to make room"* -- three-layer compression strategy for infinite sessions.
>
> **Harness layer**: Compression -- clean memory for infinite sessions.

## Problem

The context window is finite. A single `read_file` on a 1000-line file costs ~4000 tokens. After reading 30 files and running 20 bash commands, you hit 100,000+ tokens. The agent cannot work on large codebases without compression.

## Solution

Three layers, increasing in aggressiveness:

```
Every turn:
+------------------+
| Tool call result |
+------------------+
        |
        v
[Layer 1: micro_compact]        (silent, every turn)
  Replace tool_result > 3 turns old
  with "[Previous: used {tool_name}]"
        |
        v
[Check: tokens > 50000?]
   |               |
   no              yes
   |               |
   v               v
continue    [Layer 2: auto_compact]
              Save transcript to .transcripts/
              LLM summarizes conversation.
              Replace all messages with [summary].
                    |
                    v
            [Layer 3: compact tool]
              Model calls compact explicitly.
              Same summarization as auto_compact.
```

## How It Works

1. **Layer 1 -- micro_compact**: Before each LLM call, replace old tool results with placeholders.

```typescript
function micro_compact(messages: Message[]): void {
  const toolResults: { msgIdx: number; partIdx: number; result: ToolResultBlock }[] = [];

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
        const part = msg.content[partIdx] as ToolResultBlock;
        if (typeof part === "object" && part !== null && part.type === "tool_result") {
          toolResults.push({ msgIdx, partIdx, result: part });
        }
      }
    }
  }

  if (toolResults.length <= KEEP_RECENT) return;

  for (const { result } of toolResults.slice(0, -KEEP_RECENT)) {
    if (typeof result.content === "string" && result.content.length > 100) {
      result.content = `[Previous: used ${toolNameMap[result.tool_use_id] || "unknown"}]`;
    }
  }
}
```

2. **Layer 2 -- auto_compact**: When tokens exceed threshold, save full transcript to disk, then ask the LLM to summarize.

```typescript
async function auto_compact(messages: Message[]): Promise<Message[]> {
  // Save transcript for recovery
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  fs.writeFileSync(
    transcriptPath,
    messages.map((m) => JSON.stringify(m)).join("\n"),
    "utf-8"
  );

  // LLM summarizes
  const response = await client.messages.create({
    model: MODEL,
    messages: [{
      role: "user",
      content: "Summarize this conversation for continuity..." +
        JSON.stringify(messages).slice(0, 80000),
    }],
    max_tokens: 2000,
  });

  return [
    { role: "user", content: `[Compressed]\n\n${response.content[0]?.text || ""}` },
    { role: "assistant", content: "Understood. Continuing." },
  ];
}
```

3. **Layer 3 -- manual compact**: The `compact` tool triggers the same summarization on demand.

4. The loop integrates all three:

```typescript
async function agent_loop(messages: Message[]): Promise<void> {
  while (true) {
    micro_compact(messages);                        // Layer 1
    if (estimate_tokens(messages) > THRESHOLD) {
      const compacted = await auto_compact(messages);
      messages.splice(0, messages.length, ...compacted);  // Layer 2
    }
    const response = await client.messages.create(...);
    // ... tool execution ...
    if (manualCompact) {
      const compacted = await auto_compact(messages);
      messages.splice(0, messages.length, ...compacted);  // Layer 3
    }
  }
}
```

Transcripts preserve full history on disk. Nothing is truly lost -- just moved out of active context.

## What Changed From s05

| Component      | Before (s05)     | After (s06)                |
|----------------|------------------|----------------------------|
| Tools          | 5                | 5 (base + compact)         |
| Context mgmt   | None             | Three-layer compression    |
| Micro-compact  | None             | Old results -> placeholders|
| Auto-compact   | None             | Token threshold trigger    |
| Transcripts    | None             | Saved to .transcripts/     |

## Try It

```sh
cd learn-claude-code
npx tsx agents-ts/src/s06.ts
```

1. `Read every TypeScript file in the agents-ts/src/ directory one by one` (watch micro-compact replace old results)
2. `Keep reading files until compression triggers automatically`
3. `Use the compact tool to manually compress the conversation`

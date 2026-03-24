# s06: Context Compact (上下文压缩)

`s01 > s02 > s03 > s04 > s05 > [ s06 ] | s07 > s08 > s09 > s10 > s11 > s12`

> *"上下文总会满, 要有办法腾地方"* -- 三层压缩策略, 换来无限会话。
>
> **Harness 层**: 压缩 -- 干净的记忆, 无限的会话。

## 问题

上下文窗口是有限的。读一个 1000 行的文件就吃掉 ~4000 token; 读 30 个文件、跑 20 条命令, 轻松突破 100k token。不压缩, 智能体根本没法在大项目里干活。

## 解决方案

三层压缩, 激进程度递增:

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

## 工作原理

1. **第一层 -- micro_compact**: 每次 LLM 调用前, 将旧的 tool result 替换为占位符。

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

2. **第二层 -- auto_compact**: token 超过阈值时, 保存完整对话到磁盘, 让 LLM 做摘要。

```typescript
async function auto_compact(messages: Message[]): Promise<Message[]> {
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  fs.writeFileSync(
    transcriptPath,
    messages.map((m) => JSON.stringify(m)).join("\n"),
    "utf-8"
  );

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

3. **第三层 -- manual compact**: `compact` 工具按需触发同样的摘要机制。

4. 循环整合三层:

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

完整历史通过 transcript 保存在磁盘上。信息没有真正丢失, 只是移出了活跃上下文。

## 相对 s05 的变更

| 组件           | 之前 (s05)       | 之后 (s06)                     |
|----------------|------------------|--------------------------------|
| Tools          | 5                | 5 (基础 + compact)             |
| 上下文管理     | 无               | 三层压缩                       |
| Micro-compact  | 无               | 旧结果 -> 占位符               |
| Auto-compact   | 无               | token 阈值触发                 |
| Transcripts    | 无               | 保存到 .transcripts/           |

## 试一试

```sh
cd learn-claude-code
npx tsx agents-ts/src/s06.ts
```

试试这些 prompt (英文 prompt 对 LLM 效果更好, 也可以用中文):

1. `Read every TypeScript file in the agents-ts/src/ directory one by one` (观察 micro-compact 替换旧结果)
2. `Keep reading files until compression triggers automatically`
3. `Use the compact tool to manually compress the conversation`

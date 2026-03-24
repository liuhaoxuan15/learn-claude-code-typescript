# s06: Context Compact

`s01 > s02 > s03 > s04 > s05 > [ s06 ] | s07 > s08 > s09 > s10 > s11 > s12`

> *"コンテキストはいつか溢れる、空ける手段が要る"* -- 3層圧縮で無限セッションを実現。
>
> **Harness 層**: 圧縮 -- クリーンな記憶、無限のセッション。

## 問題

コンテキストウィンドウは有限だ。1000行のファイルに対する`read_file`1回で約4000トークンを消費する。30ファイルを読み20回のbashコマンドを実行すると、100,000トークン超。圧縮なしでは、エージェントは大規模コードベースで作業できない。

## 解決策

積極性を段階的に上げる3層構成:

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

## 仕組み

1. **第1層 -- micro_compact**: 各LLM呼び出しの前に、古いツール結果をプレースホルダーに置換する。

```typescript
function microCompact(messages: any[]): any[] {
    const toolResults: [number, number, any][] = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg["role"] === "user" && Array.isArray(msg.get("content"))) {
            for (let j = 0; j < msg["content"].length; j++) {
                const part = msg["content"][j];
                if (typeof part === "object" && part?.get("type") === "tool_result") {
                    toolResults.push([i, j, part]);
                }
            }
        }
    }
    if (toolResults.length <= KEEP_RECENT) {
        return messages;
    }
    for (const [,, part] of toolResults.slice(0, -KEEP_RECENT)) {
        if ((part.get("content") ?? "").length > 100) {
            part["content"] = `[Previous: used ${toolName}]`;
        }
    }
    return messages;
}
```

2. **第2層 -- auto_compact**: トークンが閾値を超えたら、完全なトランスクリプトをディスクに保存し、LLMに要約を依頼する。

```typescript
function autoCompact(messages: any[]): any[] {
    // Save transcript for recovery
    const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
    const f = fs.openSync(transcriptPath, "w");
    for (const msg of messages) {
        fs.writeSync(f, JSON.stringify(msg, (_, v) => v === undefined ? null : v) + "\n");
    }
    fs.closeSync(f);
    // LLM summarizes
    const response = client.messages.create({
        model: MODEL,
        messages: [{"role": "user", "content":
            "Summarize this conversation for continuity..."
            + JSON.stringify(messages, (_, v) => v === undefined ? null : v).slice(0, 80000)}],
        max_tokens: 2000,
    });
    return [
        {"role": "user", "content": `[Compressed]\n\n${response.content[0].text}`},
        {"role": "assistant", "content": "Understood. Continuing."},
    ];
}
```

3. **第3層 -- manual compact**: `compact`ツールが同じ要約処理をオンデマンドでトリガーする。

4. ループが3層すべてを統合する:

```typescript
function agentLoop(messages: any[]): void {
    while (true) {
        microCompact(messages);                        // Layer 1
        if (estimateTokens(messages) > THRESHOLD) {
            messages = autoCompact(messages);         // Layer 2
        }
        const response = client.messages.create({...});
        // ... tool execution ...
        if (manualCompact) {
            messages = autoCompact(messages);         // Layer 3
        }
    }
}
```

トランスクリプトがディスク上に完全な履歴を保持する。何も真に失われず、アクティブなコンテキストの外に移動されるだけ。

## s05からの変更点

| Component      | Before (s05)     | After (s06)                |
|----------------|------------------|----------------------------|
| Tools          | 5                | 5 (base + compact)         |
| Context mgmt   | None             | Three-layer compression    |
| Micro-compact  | None             | Old results -> placeholders|
| Auto-compact   | None             | Token threshold trigger    |
| Transcripts    | None             | Saved to .transcripts/     |

## 試してみる

```sh
cd learn-claude-code
npx tsx agents-ts/src/s06.ts
```

1. `Read every Python file in the agents/ directory one by one` (micro-compactが古い結果を置換するのを観察する)
2. `Keep reading files until compression triggers automatically`
3. `Use the compact tool to manually compress the conversation`

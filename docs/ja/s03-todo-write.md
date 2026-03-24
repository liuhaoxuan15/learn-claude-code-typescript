# s03: TodoWrite

`s01 > s02 > [ s03 ] s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"計画のないエージェントは行き当たりばったり"* -- まずステップを書き出し、それから実行。
>
> **Harness 層**: 計画 -- 航路を描かずにモデルを軌道に乗せる。

## 問題

マルチステップのタスクで、モデルは途中で迷子になる。作業を繰り返したり、ステップを飛ばしたり，脱線したりする。長い会話になるほど悪化する -- ツール結果がコンテキストを埋めるにつれ、システムプロンプトの影響力が薄れる。10ステップのリファクタリングでステップ1-3を完了した後、残りを忘れて即興を始めてしまう。

## 解決策

```
+--------+      +-------+      +---------+
|  User  | ---> |  LLM  | ---> | Tools   |
| prompt |      |       |      | + todo  |
+--------+      +---+---+      +----+----+
                    ^                |
                    |   tool_result  |
                    +----------------+
                          |
              +-----------+-----------+
              | TodoManager state     |
              | [ ] task A            |
              | [>] task B  <- doing  |
              | [x] task C            |
              +-----------------------+
                          |
              if roundsSinceTodo >= 3:
                inject <reminder> into tool_result
```

## 仕組み

1. TodoManagerはアイテムのリストをステータス付きで保持する。`in_progress`にできるのは同時に1つだけ。

```typescript
interface TodoItem {
  id: number;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

class TodoManager {
  private items: TodoItem[] = [];
  private nextId = 1;

  update(items: TodoItem[]): string {
    let inProgressCount = 0;
    const validated: TodoItem[] = [];

    for (const item of items) {
      if (item.status === "in_progress") {
        inProgressCount++;
      }
      validated.push({ id: item.id, text: item.text, status: item.status });
    }

    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress");
    }

    this.items = validated;
    return this.render();
  }
}
```

2. `todo`ツールは他のツールと同様にディスパッチマップに追加される。

```typescript
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // ...base tools...
  todo: (p) => TODO.update(p["items"] as TodoItem[]),
};
```

3. nagリマインダーが、モデルが3ラウンド以上`todo`を呼ばなかった場合にナッジを注入する。

```typescript
if (roundsSinceTodo >= 3 && messages.length > 0) {
  const last = messages[messages.length - 1];
  if (last.role === "user" && Array.isArray(last.content)) {
    last.content.unshift({
      type: "text",
      text: "<reminder>Update your todos.</reminder>",
    });
  }
}
```

「一度にin_progressは1つだけ」の制約が逐次的な集中を強制し、nagリマインダーが説明責任を生む。

## s02からの変更点

| Component      | Before (s02)     | After (s03)                |
|----------------|------------------|----------------------------|
| Tools          | 4                | 5 (+todo)                  |
| Planning       | None             | TodoManager with statuses  |
| Nag injection  | None             | `<reminder>` after 3 rounds|
| Agent loop     | Simple dispatch  | + roundsSinceTodo counter  |

## 試してみる

```sh
cd learn-claude-code
npx tsx agents-ts/src/s03.ts
```

1. `Refactor the file hello.ts: add type hints, docstrings, and a main guard`
2. `Create a TypeScript package with index.ts, utils.ts, and tests/test_utils.ts`
3. `Review all TypeScript files and fix any style issues`

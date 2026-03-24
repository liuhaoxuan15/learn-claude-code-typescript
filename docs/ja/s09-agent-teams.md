# s09: Agent Teams

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > s08 > [ s09 ] s10 > s11 > s12`

> *"一人で終わらないなら、チームメイトに任せる"* -- 永続チームメイト + 非同期メールボックス。
>
> **Harness 層**: チームメールボックス -- 複数モデルをファイルで協調。

## 問題

サブエージェント(s04)は使い捨てだ: 生成し、作業し、要約を返し、消滅する。アイデンティティもなく、呼び出し間の記憶もない。バックグラウンドタスク(s08)はシェルコマンドを実行するが、LLM誘導の意思決定はできない。

本物のチームワークには: (1)単一プロンプトを超えて存続する永続エージェント、(2)アイデンティティとライフサイクル管理、(3)エージェント間の通信チャネルが必要だ。

## 解決策

```
Teammate lifecycle:
  spawn -> WORKING -> IDLE -> WORKING -> ... -> SHUTDOWN

Communication:
  .team/
    config.json           <- team roster + statuses
    inbox/
      alice.jsonl         <- append-only, drain-on-read
      bob.jsonl
      lead.jsonl

              +--------+    send("alice","bob","...")    +--------+
              | alice  | -----------------------------> |  bob   |
              | loop   |    bob.jsonl << {json_line}    |  loop  |
              +--------+                                +--------+
                   ^                                         |
                   |        BUS.read_inbox("alice")          |
                   +---- alice.jsonl -> read + drain ---------+
```

## 仕組み

1. TeammateManagerがconfig.jsonでチーム名簿を管理する。

```typescript
class TeammateManager {
    private dir: string;
    private configPath: string;
    private config: any;
    private threads: Record<string, threading.Thread> = {};

    constructor(teamDir: string) {
        this.dir = teamDir;
        fs.mkdirSync(teamDir, { recursive: true });
        this.configPath = path.join(teamDir, "config.json");
        this.config = this.loadConfig();
    }
}
```

2. `spawn()`がチームメイトを作成し、そのエージェントループをスレッドで開始する。

```typescript
    spawn(name: string, role: string, prompt: string): string {
        const member = {"name": name, role, "status": "working"};
        this.config["members"].push(member);
        this.saveConfig();
        const thread = new threading.Thread({
            target: () => this.teammateLoop(name, role, prompt),
            daemon: true,
        });
        thread.start();
        return `Spawned teammate '${name}' (role: ${role})`;
    }
```

3. MessageBus: 追記専用のJSONLインボックス。`send()`がJSON行を追記し、`read_inbox()`がすべて読み取ってドレインする。

```typescript
class MessageBus {
    send(sender: string, to: string, content: string, msgType = "message", extra?: any): void {
        const msg: any = {"type": msgType, "from": sender,
               "content": content, "timestamp": Date.now() / 1000};
        if (extra) {
            Object.assign(msg, extra);
        }
        const f = fs.openSync(path.join(this.dir, `${to}.jsonl`), "a");
        fs.writeSync(f, JSON.stringify(msg) + "\n");
        fs.closeSync(f);
    }

    readInbox(name: string): string {
        const p = path.join(this.dir, `${name}.jsonl`);
        if (!fs.existsSync(p)) return "[]";
        const lines = fs.readFileSync(p, "utf-8").trim().split("\n").filter(l => l);
        const msgs = lines.map(l => JSON.parse(l));
        fs.writeFileSync(p, "");  // drain
        return JSON.stringify(msgs, null, 2);
    }
}
```

4. 各チームメイトは各LLM呼び出しの前にインボックスを確認し、受信メッセージをコンテキストに注入する。

```typescript
    private teammateLoop(name: string, role: string, prompt: string): void {
        const messages = [{"role": "user", "content": prompt}];
        for (let i = 0; i < 50; i++) {
            const inbox = BUS.readInbox(name);
            if (inbox !== "[]") {
                messages.push({"role": "user",
                    "content": `<inbox>${inbox}</inbox>`});
                messages.push({"role": "assistant",
                    "content": "Noted inbox messages."});
            }
            const response = client.messages.create({...});
            if (response.stop_reason !== "tool_use") {
                break;
            }
            // execute tools, append results...
        }
        this.findMember(name)["status"] = "idle";
    }
```

## s08からの変更点

| Component      | Before (s08)     | After (s09)                |
|----------------|------------------|----------------------------|
| Tools          | 6                | 9 (+spawn/send/read_inbox) |
| Agents         | Single           | Lead + N teammates         |
| Persistence    | None             | config.json + JSONL inboxes|
| Threads        | Background cmds  | Full agent loops per thread|
| Lifecycle      | Fire-and-forget  | idle -> working -> idle    |
| Communication  | None             | message + broadcast        |

## 試してみる

```sh
cd learn-claude-code
npx tsx agents-ts/src/s09.ts
```

1. `Spawn alice (coder) and bob (tester). Have alice send bob a message.`
2. `Broadcast "status update: phase 1 complete" to all teammates`
3. `Check the lead inbox for any messages`
4. `/team`と入力してステータス付きのチーム名簿を確認する
5. `/inbox`と入力してリーダーのインボックスを手動確認する

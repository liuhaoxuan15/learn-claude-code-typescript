# s08: Background Tasks

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > [ s08 ] s09 > s10 > s11 > s12`

> *"遅い操作はバックグラウンドへ、エージェントは次を考え続ける"* -- デーモンスレッドがコマンド実行、完了後に通知を注入。
>
> **Harness 層**: バックグラウンド実行 -- モデルが考え続ける間、Harness が待つ。

## 問題

一部のコマンドは数分かかる: `npm install`、`pytest`、`docker build`。ブロッキングループでは、モデルはサブプロセスの完了を待って座っている。ユーザーが「依存関係をインストールして、その間にconfigファイルを作って」と言っても、エージェントは並列ではなく逐次的に処理する。

## 解決策

```
Main thread                Background thread
+-----------------+        +-----------------+
| agent loop      |        | subprocess runs |
| ...             |        | ...             |
| [LLM call] <---+------- | enqueue(result) |
|  ^drain queue   |        +-----------------+
+-----------------+

Timeline:
Agent --[spawn A]--[spawn B]--[other work]----
             |          |
             v          v
          [A runs]   [B runs]      (parallel)
             |          |
             +-- results injected before next LLM call --+
```

## 仕組み

1. BackgroundManagerがスレッドセーフな通知キューでタスクを追跡する。

```typescript
class BackgroundManager {
    private tasks: Record<string, {status: string, command: string}> = {};
    private _notificationQueue: any[] = [];
    private _lock = new threading.Lock();
}
```

2. `run()`がデーモンスレッドを開始し、即座にリターンする。

```typescript
    run(command: string): string {
        const taskId = uuid.v4().slice(0, 8);
        this.tasks[taskId] = {"status": "running", command};
        const thread = new threading.Thread({
            target: () => this.execute(taskId, command),
            daemon: true,
        });
        thread.start();
        return `Background task ${taskId} started`;
    }
```

3. サブプロセス完了時に、結果を通知キューへ。

```typescript
    private execute(taskId: string, command: string): void {
        try {
            const r = subprocess.run(command, {
                shell: true,
                cwd: WORKDIR,
                capture_output: true,
                text: true,
                timeout: 300,
            });
            const output = ((r.stdout ?? "") + (r.stderr ?? "")).trim().slice(0, 50000);
        } catch (e) {
            const output = "Error: Timeout (300s)";
        }
        this._lock.lock();
        try {
            this._notificationQueue.push({
                "task_id": taskId, "result": output.slice(0, 500)});
        } finally {
            this._lock.unlock();
        }
    }
```

4. エージェントループが各LLM呼び出しの前に通知をドレインする。

```typescript
function agentLoop(messages: any[]): void {
    while (true) {
        const notifs = BG.drainNotifications();
        if (notifs.length > 0) {
            const notifText = notifs
                .map((n: any) => `[bg:${n["task_id"]}] ${n["result"]}`)
                .join("\n");
            messages.push({"role": "user",
                "content": `<background-results>\n${notifText}\n</background-results>`});
            messages.push({"role": "assistant",
                "content": "Noted background results."});
        }
        const response = client.messages.create({...});
    }
}
```

ループはシングルスレッドのまま。サブプロセスI/Oだけが並列化される。

## s07からの変更点

| Component      | Before (s07)     | After (s08)                |
|----------------|------------------|----------------------------|
| Tools          | 8                | 6 (base + background_run + check)|
| Execution      | Blocking only    | Blocking + background threads|
| Notification   | None             | Queue drained per loop     |
| Concurrency    | None             | Daemon threads             |

## 試してみる

```sh
cd learn-claude-code
npx tsx agents-ts/src/s08.ts
```

1. `Run "sleep 5 && echo done" in the background, then create a file while it runs`
2. `Start 3 background tasks: "sleep 2", "sleep 4", "sleep 6". Check their status.`
3. `Run pytest in the background and keep working on other things`

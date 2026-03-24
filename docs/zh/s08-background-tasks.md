# s08: Background Tasks (后台任务)

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > [ s08 ] s09 > s10 > s11 > s12`

> *"慢操作丢后台, agent 继续想下一步"* -- 后台线程跑命令, 完成后注入通知。
>
> **Harness 层**: 后台执行 -- 模型继续思考, harness 负责等待。

## 问题

有些命令要跑好几分钟: `npm install`、`jest`、`docker build`。阻塞式循环下模型只能干等。用户说 "装依赖, 顺便建个配置文件", 智能体却只能一个一个来。

## 解决方案

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

## 工作原理

1. BackgroundManager 用通知队列追踪任务。

```typescript
interface BackgroundTask {
  status: "running" | "completed" | "error" | "timeout";
  result: string | null;
  command: string;
}

interface Notification {
  task_id: string;
  status: string;
  command: string;
  result: string;
}

class BackgroundManager {
  private tasks = new Map<string, BackgroundTask>();
  private notificationQueue: Notification[] = [];

  run(command: string): string {
    const taskId = crypto.randomUUID().slice(0, 8);
    this.tasks.set(taskId, { status: "running", result: null, command });
    setTimeout(() => this.execute(taskId, command), 0);
    return `Background task ${taskId} started: ${command.slice(0, 80)}`;
  }

  drainNotifications(): Notification[] {
    const notifs = [...this.notificationQueue];
    this.notificationQueue = [];
    return notifs;
  }
}
```

2. 每次 LLM 调用前排空通知队列。

```typescript
async function agent_loop(messages: Message[]): Promise<void> {
  while (true) {
    const notifs = BG.drainNotifications();
    if (notifs.length > 0 && messages.length > 0) {
      const notifText = notifs.map(
        (n) => `[bg:${n.task_id}] ${n.status}: ${n.result}`
      ).join("\n");
      messages.push({
        role: "user",
        content: `<background-results>\n${notifText}\n</background-results>`,
      });
      messages.push({ role: "assistant", content: "Noted background results." });
    }
    const response = await client.messages.create(...);
  }
}
```

循环保持单线程。只有子进程 I/O 被并行化。

## 相对 s07 的变更

| 组件           | 之前 (s07)       | 之后 (s08)                         |
|----------------|------------------|------------------------------------|
| Tools          | 8                | 6 (基础 + background_run + check)  |
| 执行方式       | 仅阻塞           | 阻塞 + 后台线程                    |
| 通知机制       | 无               | 每轮排空的队列                     |
| 并发           | 无               | setTimeout 并行                    |

## 试一试

```sh
cd learn-claude-code
npx tsx agents-ts/src/s08.ts
```

试试这些 prompt (英文 prompt 对 LLM 效果更好, 也可以用中文):

1. `Run "sleep 5 && echo done" in the background, then create a file while it runs`
2. `Start 3 background tasks: "sleep 2", "sleep 4", "sleep 6". Check their status.`
3. `Run jest in the background and keep working on other things`

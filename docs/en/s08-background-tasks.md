# s08: Background Tasks

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > [ s08 ] s09 > s10 > s11 > s12`

> *"Run slow operations in the background; the agent keeps thinking"* -- daemon threads run commands, inject notifications on completion.
>
> **Harness layer**: Background execution -- the model thinks while the harness waits.

## Problem

Some commands take minutes: `npm install`, `jest`, `docker build`. With a blocking loop, the model sits idle waiting. If the user asks "install dependencies and while that runs, create the config file," the agent does them sequentially, not in parallel.

## Solution

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

## How It Works

1. BackgroundManager tracks tasks with a notification queue.

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

2. The agent loop drains notifications before each LLM call.

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

The loop stays single-threaded. Only subprocess I/O is parallelized.

## What Changed From s07

| Component      | Before (s07)     | After (s08)                |
|----------------|------------------|----------------------------|
| Tools          | 8                | 6 (base + background_run + check)|
| Execution      | Blocking only    | Blocking + background threads|
| Notification   | None             | Queue drained per loop     |
| Concurrency    | None             | setTimeout for parallelism |

## Try It

```sh
cd learn-claude-code
npx tsx agents-ts/src/s08.ts
```

1. `Run "sleep 5 && echo done" in the background, then create a file while it runs`
2. `Start 3 background tasks: "sleep 2", "sleep 4", "sleep 6". Check their status.`
3. `Run jest in the background and keep working on other things`

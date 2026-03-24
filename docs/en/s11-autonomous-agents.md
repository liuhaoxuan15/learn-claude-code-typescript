# s11: Autonomous Agents

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > [ s11 ] s12`

> *"Teammates scan the board and claim tasks themselves"* -- no need for the lead to assign each one.
>
> **Harness layer**: Autonomy -- models that find work without being told.

## Problem

In s09-s10, teammates only work when explicitly told to. The lead must spawn each one with a specific prompt. 10 unclaimed tasks on the board? The lead assigns each one manually. Doesn't scale.

True autonomy: teammates scan the task board themselves, claim unclaimed tasks, work on them, then look for more.

One subtlety: after context compression (s06), the agent might forget who it is. Identity re-injection fixes this.

## Solution

```
Teammate lifecycle with idle cycle:

+-------+
| spawn |
+---+---+
    |
    v
+-------+   tool_use     +-------+
| WORK  | <------------- |  LLM  |
+---+---+                +-------+
    |
    | stop_reason != tool_use (or idle tool called)
    v
+--------+
|  IDLE  |  poll every 5s for up to 60s
+---+----+
    |
    +---> check inbox --> message? ----------> WORK
    |
    +---> scan .tasks/ --> unclaimed? -------> claim -> WORK
    |
    +---> 60s timeout ----------------------> SHUTDOWN

Identity re-injection after compression:
  if messages.length <= 3:
    messages.unshift(identityBlock)
```

## How It Works

1. The teammate loop has two phases: WORK and IDLE. When the LLM stops calling tools (or calls `idle`), the teammate enters IDLE.

```typescript
private async teammateLoop(name: string, role: string, prompt: string): Promise<void> {
  const sysPrompt = `You are '${name}', role: ${role}, at ${WORKDIR}.`;

  while (true) {
    // -- WORK PHASE --
    const messages: Message[] = [{ role: "user", content: prompt }];

    for (let i = 0; i < 50; i++) {
      const response = await client.messages.create({...});
      if (response.stop_reason !== "tool_use") break;
      // execute tools...
      if (idleRequested) break;
    }

    // -- IDLE PHASE --
    this.setStatus(name, "idle");
    const resume = await this.idlePoll(name, messages);
    if (!resume) {
      this.setStatus(name, "shutdown");
      return;
    }
    this.setStatus(name, "working");
  }
}
```

2. The idle phase polls inbox and task board in a loop.

```typescript
private async idlePoll(name: string, messages: Message[]): Promise<boolean> {
  const IDLE_TIMEOUT = 60000;
  const POLL_INTERVAL = 5000;
  const maxPolls = IDLE_TIMEOUT / POLL_INTERVAL;

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

    const inbox = BUS.readInbox(name);
    if (inbox.length > 0) {
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox)}</inbox>` });
      return true;
    }

    const unclaimed = this.scanUnclaimedTasks();
    if (unclaimed.length > 0) {
      this.claimTask(unclaimed[0].id, name);
      messages.push({
        role: "user",
        content: `<auto-claimed>Task #${unclaimed[0].id}: ${unclaimed[0].subject}</auto-claimed>`,
      });
      return true;
    }
  }
  return false;  // timeout -> shutdown
}
```

3. Task board scanning: find pending, unowned, unblocked tasks.

```typescript
private scanUnclaimedTasks(): Task[] {
  const unclaimed: Task[] = [];
  if (!fs.existsSync(TASKS_DIR)) return unclaimed;

  for (const f of fs.readdirSync(TASKS_DIR).sort()) {
    if (!f.endsWith(".json")) continue;
    const task: Task = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), "utf-8"));
    if (task.status === "pending" && !task.owner && task.blockedBy.length === 0) {
      unclaimed.push(task);
    }
  }
  return unclaimed;
}
```

4. Identity re-injection: when context is too short (compression happened), insert an identity block.

```typescript
if (messages.length <= 3) {
  messages.unshift({
    role: "user",
    content: `<identity>You are '${name}', role: ${role}, team: ${TEAM_NAME}. Continue your work.</identity>`,
  });
  messages.splice(1, 0, { role: "assistant", content: `I am ${name}. Continuing.` });
}
```

## What Changed From s10

| Component      | Before (s10)     | After (s11)                |
|----------------|------------------|----------------------------|
| Tools          | 12               | 14 (+idle, +claim_task)    |
| Autonomy       | Lead-directed    | Self-organizing            |
| Idle phase     | None             | Poll inbox + task board    |
| Task claiming  | Manual only      | Auto-claim unclaimed tasks |
| Identity       | System prompt    | + re-injection after compress|
| Timeout        | None             | 60s idle -> auto shutdown  |

## Try It

```sh
cd learn-claude-code
npx tsx agents-ts/src/s11.ts
```

1. `Create 3 tasks on the board, then spawn alice and bob. Watch them auto-claim.`
2. `Spawn a coder teammate and let it find work from the task board itself`
3. `Create tasks with dependencies. Watch teammates respect the blocked order.`
4. Type `/tasks` to see the task board with owners
5. Type `/team` to monitor who is working vs idle

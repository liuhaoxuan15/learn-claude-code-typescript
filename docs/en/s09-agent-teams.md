# s09: Agent Teams

`s01 > s02 > s03 > s04 > s05 > s06 | s07 > s08 > [ s09 ] s10 > s11 > s12`

> *"When the task is too big for one, delegate to teammates"* -- persistent teammates + async mailboxes.
>
> **Harness layer**: Team mailboxes -- multiple models, coordinated through files.

## Problem

Subagents (s04) are disposable: spawn, work, return summary, die. No identity, no memory between invocations. Background tasks (s08) run shell commands but can't make LLM-guided decisions.

Real teamwork needs: (1) persistent agents that outlive a single prompt, (2) identity and lifecycle management, (3) a communication channel between agents.

## Solution

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
                   |        BUS.readInbox("alice")          |
                   +---- alice.jsonl -> read + drain ---------+
```

## How It Works

1. TeammateManager maintains config.json with the team roster.

```typescript
interface Member {
  name: string;
  role: string;
  status: "working" | "idle" | "shutdown";
}

interface TeamConfig {
  team_name: string;
  members: Member[];
}

class TeammateManager {
  private dir: string;
  private configPath: string;
  private config: TeamConfig;
  private threads: Map<string, { status: string }>;

  constructor(teamDir: string) {
    this.dir = teamDir;
    this.configPath = path.join(this.dir, "config.json");
    fs.mkdirSync(this.dir, { recursive: true });
    this.config = this.loadConfig();
    this.threads = new Map();
  }
}
```

2. `spawn()` creates a teammate and starts its agent loop in a thread.

```typescript
spawn(name: string, role: string, prompt: string): string {
  const member: Member = { name, role, status: "working" };
  this.config.members.push(member);
  this.saveConfig();

  const threadInfo = { status: "running" };
  this.threads.set(name, threadInfo);

  setTimeout(() => {
    this.teammateLoop(name, role, prompt);
    threadInfo.status = "stopped";
  }, 0);

  return `Spawned '${name}' (role: ${role})`;
}
```

3. MessageBus: append-only JSONL inboxes. `send()` appends a JSON line; `readInbox()` reads all and drains.

```typescript
class MessageBus {
  send(sender: string, to: string, content: string, msgType = "message"): string {
    const msg: Message = {
      type: msgType,
      from: sender,
      content,
      timestamp: Date.now(),
    };
    const inboxPath = path.join(this.dir, `${to}.jsonl`);
    fs.appendFileSync(inboxPath, JSON.stringify(msg) + "\n", "utf-8");
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name: string): Message[] {
    const inboxPath = path.join(this.dir, `${name}.jsonl`);
    if (!fs.existsSync(inboxPath)) return [];
    const content = fs.readFileSync(inboxPath, "utf-8").trim();
    if (!content) return [];
    const messages = content.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    fs.writeFileSync(inboxPath, "", "utf-8");  // drain
    return messages;
  }
}
```

4. Each teammate checks its inbox before every LLM call, injecting received messages into context.

```typescript
private async teammateLoop(name: string, role: string, prompt: string): Promise<void> {
  const messages: Message[] = [{ role: "user", content: prompt }];

  for (let i = 0; i < 50; i++) {
    const inbox = BUS.readInbox(name);
    for (const msg of inbox) {
      messages.push({ role: "user", content: JSON.stringify(msg) });
    }
    // ... LLM call loop ...
  }

  const member = this.findMember(name);
  if (member && member.status !== "shutdown") {
    member.status = "idle";
    this.saveConfig();
  }
}
```

## What Changed From s08

| Component      | Before (s08)     | After (s09)                |
|----------------|------------------|----------------------------|
| Tools          | 6                | 9 (+spawn/send/read_inbox) |
| Agents         | Single           | Lead + N teammates         |
| Persistence    | None             | config.json + JSONL inboxes|
| Threads        | Background cmds  | Full agent loops per thread|
| Lifecycle      | Fire-and-forget  | idle -> working -> idle    |
| Communication  | None             | message + broadcast        |

## Try It

```sh
cd learn-claude-code
npx tsx agents-ts/src/s09.ts
```

1. `Spawn alice (coder) and bob (tester). Have alice send bob a message.`
2. `Broadcast "status update: phase 1 complete" to all teammates`
3. `Check the lead inbox for any messages`
4. Type `/team` to see the team roster with statuses
5. Type `/inbox` to manually check the lead's inbox

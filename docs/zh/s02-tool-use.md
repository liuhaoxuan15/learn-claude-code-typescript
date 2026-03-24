# s02: Tool Use (工具使用)

`s01 > [ s02 ] s03 > s04 > s05 > s06 | s07 > s08 > s09 > s10 > s11 > s12`

> *"加一个工具, 只加一个 handler"* -- 循环不用动, 新工具注册进 dispatch map 就行。
>
> **Harness 层**: 工具分发 -- 扩展模型能触达的边界。

## 问题

只有 `bash` 时, 所有操作都走 shell。`cat` 截断不可预测, `sed` 遇到特殊字符就崩, 每次 bash 调用都是不受约束的安全面。专用工具 (`read_file`, `write_file`) 可以在工具层面做路径沙箱。

关键洞察: 加工具不需要改循环。

## 解决方案

```
+--------+      +-------+      +------------------+
|  User  | ---> |  LLM  | ---> | Tool Dispatch    |
| prompt |      |       |      | {                |
+--------+      +---+---+      |   bash: run_bash |
                    ^           |   read: run_read |
                    |           |   write: run_wr  |
                    +-----------+   edit: run_edit |
                    tool_result | }                |
                                +------------------+

The dispatch map is a record: {tool_name: handler_function}.
One lookup replaces any if/elif chain.
```

## 工作原理

1. 每个工具有一个处理函数。路径沙箱防止逃逸工作区。

```typescript
function safe_path(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const relative = path.relative(WORKDIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(p)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function run_read(filePath: string, limit?: number): string {
  try {
    const lines = fs.readFileSync(safe_path(filePath), "utf-8").split("\n");
    if (limit && lines.length > limit) {
      lines.push(`... (${lines.length - limit} more)`);
    }
    return lines.join("\n").slice(0, 50000);
  } catch (e) {
    return `Error: ${e}`;
  }
}
```

2. dispatch map 将工具名映射到处理函数。

```typescript
type ToolHandler = (params: Record<string, unknown>) => string;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: (p) => run_bash(p["command"] as string),
  read_file: (p) => run_read(p["path"] as string, p["limit"] as number | undefined),
  write_file: (p) => run_write(p["path"] as string, p["content"] as string),
  edit_file: (p) => run_edit(p["path"] as string, p["old_text"] as string, p["new_text"] as string),
};
```

3. 循环中按名称查找处理函数。循环体本身与 s01 完全一致。

```typescript
for (const block of response.content) {
  if (block.type === "tool_use") {
    const handler = TOOL_HANDLERS[block.name];
    const output = handler
      ? handler(block.input)
      : `Unknown tool: ${block.name}`;
    results.push({
      type: "tool_result",
      tool_use_id: block.id,
      content: String(output),
    });
  }
}
```

加工具 = 加 handler + 加 schema。循环永远不变。

## 相对 s01 的变更

| 组件           | 之前 (s01)         | 之后 (s02)                     |
|----------------|--------------------|--------------------------------|
| Tools          | 1 (仅 bash)        | 4 (bash, read, write, edit)    |
| Dispatch       | 硬编码 bash 调用   | `TOOL_HANDLERS` 字典           |
| 路径安全       | 无                 | `safe_path()` 沙箱             |
| Agent loop     | 不变               | 不变                           |

## 试一试

```sh
cd learn-claude-code
npx tsx agents-ts/src/s02.ts
```

试试这些 prompt (英文 prompt 对 LLM 效果更好, 也可以用中文):

1. `Read the file requirements.txt`
2. `Create a file called greet.ts with a greet(name) function`
3. `Edit greet.ts to add a docstring to the function`
4. `Read greet.ts to verify the edit worked`

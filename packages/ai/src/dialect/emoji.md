## Format guide

A tool call is one physical line: `🔧function_name {"arg":"value"}`.

The `🔧` marker is the first character, immediately followed by a listed function name and one JSON object containing its arguments:

```text
🔧read {"path":"src/main.ts","count":20}
```

Multiple calls are parallel lines in the same reply:

```text
🔧read {"path":"src/a.ts"}
🔧read {"path":"src/b.ts"}
```

Tool results arrive later as result blocks. Failures use `📦error` instead of `📦result`. The final `📬` run on the header is the exact closing fence; it widens when the result contains that marker:

```text
📦result read 📬
verbatim tool result
📬
```

If private reasoning must be written in-band, place it in a `<think>` block:

```text
<think>
brief private reasoning
</think>
```

## Rules

- The function name MUST exactly match a listed function.
- The argument payload MUST be one complete JSON object on the same physical line as `🔧`; escape newlines inside strings as `\n`.
- Multiple calls = multiple consecutive `🔧` lines. Do not wrap them in an array or envelope.
- You MAY write visible text before the calls.
- NEVER put a call in Markdown fences, block quotes, `<example>`/`<examples>` blocks, or a `<think>` block; those are inert text.
- NEVER emit native `tool_calls` JSON or write `📦result`, `📦error`, or `📬` blocks yourself.
- Read result blocks in call order.
- Write every call line completely, THEN halt. Never announce a tool and stop before emitting its `🔧` line.

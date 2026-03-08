---
name: copilot-connect
description: |
  **INTEGRATION SKILL** — Connect external tools and code to GitHub Copilot via CopilotConnect.
  USE FOR: discovering available endpoints; sending chat completions; streaming; tool calling;
  toggling Echo/Bridge mode; understanding which OpenAI parameters actually take effect.
  TRIGGER: whenever a user asks how to call CopilotConnect, integrate it into their code,
  or troubleshoot connection issues. DO NOT USE FOR: modifying the extension source itself.
---

# CopilotConnect — Usage Skill

CopilotConnect is a VS Code extension that exposes GitHub Copilot as a **local OpenAI-compatible
HTTP server**. Any tool that speaks the OpenAI protocol works with it — no API key required.

---

## Quick Start

| Item             | Value                                                            |
| ---------------- | ---------------------------------------------------------------- |
| Default base URL | `http://127.0.0.1:1288`                                          |
| Config key       | `copilotConnect.port` (default `1288`)                           |
| Status bar       | `$(radio-tower) Copilot Connect: 1288` (dark orange = Echo mode) |

```bash
# Install from source
npm install && npm run compile && npm run package
# VS Code → Extensions: Install from VSIX → select copilot-connect-*.vsix
```

Extension auto-starts on VS Code launch. Click the status bar item for the settings menu.

---

## API Endpoints

### GET /health

```bash
curl http://localhost:1288/health
# {"status":"ok","port":1288,"version":"1.3.1","mode":"bridge"}
```

### GET /v1/models

Returns Copilot-available models in OpenAI list format.

```bash
curl http://localhost:1288/v1/models
```

### POST /v1/chat/completions

Full OpenAI-compatible chat endpoint (streaming and non-streaming, tool calling).

### POST /v1/mode

```bash
curl -X POST http://localhost:1288/v1/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"echo"}'   # or "bridge"
```

---

## Echo Mode

Echo mode lets you test your integration **without consuming real Copilot requests**.

| Aspect           | Bridge mode (default)                    | Echo mode                                                      |
| ---------------- | ---------------------------------------- | -------------------------------------------------------------- |
| Chat completions | Forwarded to GitHub Copilot              | Returns `[Echo] <user message>` in the same JSON/SSE structure |
| GET /v1/models   | Fetches live from Copilot, caches result | Serves last cached model list                                  |
| Status bar       | Default blue background                  | Dark orange background, shows `Echo:` label                    |
| Real tokens used | Yes                                      | No                                                             |

**How to enable:**

1. **Status bar menu** → click `$(radio-tower) Copilot Connect: 1288` → _Switch to Echo Mode_
2. **Command palette** → `Copilot Connect: Toggle Echo Mode`
3. **API** → `POST /v1/mode` with `{"mode":"echo"}`

At startup the extension pre-fetches and caches models so Echo mode always has a model list.
Toggle back with `{"mode":"bridge"}` or via the menu.

> Echo responses have **identical JSON/SSE structure** to real responses — `object`, `choices`,
> `finish_reason`, `usage` fields are all present. Only the content differs.

---

## Supported Parameters

Parameters are passed to `vscode.LanguageModelChat.sendRequest`. Support depends on the VS Code
LM API and the underlying GitHub Copilot model.

| Parameter                              | Handled by                    | Effective?                                                                                    |
| -------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------- |
| `model`                                | CopilotConnect                | ✅ Routes to the matching VS Code LM model; falls back to best Copilot model                  |
| `messages`                             | CopilotConnect                | ✅ Required. Converted to VS Code LM message format                                           |
| `stream`                               | CopilotConnect                | ✅ `true` → SSE; `false` → single JSON response                                               |
| `stream_options`                       | CopilotConnect                | ✅ `{include_usage:true}` appends a usage chunk before `[DONE]`                               |
| `n`                                    | CopilotConnect                | ✅ Handler is invoked _n_ times; each produces an independent choice                          |
| `response_format`                      | CopilotConnect                | ✅ `{type:"json_object"}` injects a JSON system prompt                                        |
| `tools`                                | VS Code LM API                | ✅ Converted to `LanguageModelChatTool[]`; supported by `gpt-4o`, `gpt-4.1`                   |
| `tool_choice`                          | VS Code LM API                | ✅ `"auto"` / `"required"` / `"none"`. Forcing a specific function is treated as `"auto"`     |
| `max_tokens` / `max_completion_tokens` | VS Code LM API `modelOptions` | ⚠️ Forwarded; GitHub Copilot respects a token ceiling but exact semantics are model-dependent |
| `temperature`                          | VS Code LM API `modelOptions` | ⚠️ Forwarded; accepted by the API but **GitHub Copilot ignores it** in practice               |
| `top_p`                                | VS Code LM API `modelOptions` | ⚠️ Forwarded; **not observed to have effect** with GitHub Copilot models                      |
| `stop`                                 | VS Code LM API `modelOptions` | ⚠️ Forwarded; stop-sequence support is **model-dependent and unreliable** with Copilot        |
| `seed`                                 | VS Code LM API `modelOptions` | ❌ Forwarded but **not supported** — GitHub Copilot responses are non-deterministic           |
| `presence_penalty`                     | VS Code LM API `modelOptions` | ❌ Forwarded but **not supported** by GitHub Copilot models                                   |
| `frequency_penalty`                    | VS Code LM API `modelOptions` | ❌ Forwarded but **not supported** by GitHub Copilot models                                   |
| `logit_bias`                           | VS Code LM API `modelOptions` | ❌ Forwarded but **not supported** by GitHub Copilot models                                   |
| `user`                                 | VS Code LM API `modelOptions` | ❌ Accepted for OpenAI compatibility; **not used** by the VS Code LM API                      |

**Legend:** ✅ works as documented · ⚠️ forwarded, partial/uncertain effect · ❌ accepted but has no effect

> **Note on token counts:** `usage.prompt_tokens` and `usage.completion_tokens` are always `0`
> because the VS Code LM API does not expose token counts.

---

## Usage Examples

### Non-streaming (curl)

```bash
curl -X POST http://localhost:1288/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5-mini","messages":[{"role":"user","content":"Hello"}]}'
```

### Streaming (curl)

```bash
curl -X POST http://localhost:1288/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Count to 3"}],"stream":true}'
```

### Python (openai SDK)

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:1288/v1", api_key="not-needed")

# List models
for m in client.models.list().data:
    print(m.id)

# Chat
resp = client.chat.completions.create(
    model="gpt-4o", messages=[{"role":"user","content":"Hi"}]
)
print(resp.choices[0].message.content)

# Streaming
for chunk in client.chat.completions.create(
    model="gpt-4o", messages=[{"role":"user","content":"Count to 5"}], stream=True
):
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

### Node.js (openai SDK)

```typescript
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://localhost:1288/v1", apiKey: "x" });

const resp = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(resp.choices[0].message.content);
```

### LangChain (Python)

```python
from langchain_openai import ChatOpenAI
llm = ChatOpenAI(model="gpt-4o", openai_api_base="http://localhost:1288/v1", openai_api_key="x")
print(llm.invoke("Hello").content)
```

---

## VS Code Settings

| Setting                            | Default | Description                                 |
| ---------------------------------- | ------- | ------------------------------------------- |
| `copilotConnect.port`              | `1288`  | HTTP server port                            |
| `copilotConnect.defaultModel`      | `""`    | Model id when client sends no `model` field |
| `copilotConnect.additionalContext` | `""`    | Text prepended to all system contexts       |
| `copilotConnect.language`          | `"en"`  | UI language (`"en"` or `"zh"`)              |

---

## Troubleshooting

| Symptom                              | Cause                       | Fix                                                    |
| ------------------------------------ | --------------------------- | ------------------------------------------------------ |
| `Connection refused`                 | Extension not started       | Status bar → Start; or `Copilot Connect: Start Bridge` |
| `No matching language model`         | Copilot not signed in       | Sign in to GitHub Copilot in VS Code                   |
| `EADDRINUSE`                         | Port in use                 | Change port in settings; restart bridge                |
| Models return only `"default"`       | Copilot not yet loaded      | Wait a few seconds; retry `GET /v1/models`             |
| Tool calls not returned              | Model doesn't support tools | Use `gpt-4o` or `gpt-4.1`                              |
| Echo mode still active after restart | Mode is in-memory only      | Default is always Bridge on start; no saved state      |
| Reload required after install        | VS Code caches extensions   | Run `Developer: Reload Window`                         |

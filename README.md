# Copilot Connect (Copilot 信使)

A lightweight VS Code extension that exposes GitHub Copilot through a local HTTP bridge. It provides REST endpoints for model discovery, chat (non-streaming and streaming via SSE), and session management so external clients can integrate with Copilot.

Installation, quick usage, API examples and troubleshooting are below.

---

## Key features

- Local HTTP bridge for Copilot (default port: 1288)
- Real Copilot models via `/models` and OpenAI-compatible `/v1/models`
- **Dual API support**: Original Copilot Connect endpoints + OpenAI API compatible endpoints
- Non-streaming `/chat` and streaming `/chat/stream` (SSE)
- OpenAI-compatible `/v1/chat/completions` with streaming support
- Session lifecycle endpoints (`/session/*`) with `modelId` tracking
- Status bar menu in VS Code (English / 中文)

---

## Installation

### From VSIX (recommended)

1. Build or obtain `copilot-connect-1.1.0.vsix`.
2. In VS Code: Cmd+Shift+P → `Extensions: Install from VSIX...` → select the VSIX file.
3. Reload window: Cmd+Shift+P → `Developer: Reload Window`.

### From source

```bash
npm install
npm run compile
npm run package   # creates copilot-connect-1.1.0.vsix
```

Then install the VSIX using the steps above.

> NOTE: After installing or updating the extension you must reload the VS Code window.

---

## Quick start

1. Start VS Code (the extension auto-starts). Click the status bar item to open the Copilot Connect menu.
2. Use the menu to start/stop the bridge, change port, select default model, or set additional context.

The status bar shows current state and port, e.g. `$(radio-tower) Connect: Running :1288`.

---

## API (examples)

Base URL: `http://localhost:1288`

### Original Copilot Connect Endpoints

Health

```bash
curl http://localhost:1288/health
```

Models

```bash
curl http://localhost:1288/models
```

Create session

```bash
curl -X POST http://localhost:1288/session/create
```

Get session

```bash
curl http://localhost:1288/session/<sessionId>
```

Chat (non-streaming)

```bash
curl -X POST http://localhost:1288/chat \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Explain REST API","model_id":"copilot-gpt-4","newSession":true}'
```

Chat (streaming / SSE)

```bash
curl -X POST http://localhost:1288/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Write hello world in Python","model_id":"copilot-gpt-4"}'
```

Streaming returns SSE events with `data: {"type":"chunk", "content":"..."}` and a `session` event with the sessionId.

### OpenAI API Compatible Endpoints

These endpoints follow the OpenAI API specification and can be used with OpenAI-compatible clients and tools.

**📖 For detailed documentation, examples, and integration guides, see [OPENAI_API.md](./OPENAI_API.md)**

List Models (OpenAI format)

```bash
curl http://localhost:1288/v1/models
```

Returns:

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-4o",
      "object": "model",
      "created": 1699999999,
      "owned_by": "copilot"
    }
  ]
}
```

Chat Completions (non-streaming)

```bash
curl -X POST http://localhost:1288/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Explain REST API"}
    ]
  }'
```

Returns:

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1699999999,
  "model": "gpt-4o",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "REST API is..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

Chat Completions (streaming)

```bash
curl -X POST http://localhost:1288/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [
      {"role": "user", "content": "Write hello world in Python"}
    ],
    "stream": true
  }'
```

Returns SSE stream with OpenAI format:

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1699999999,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"print"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","created":1699999999,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"("},"finish_reason":null}]}

...

data: [DONE]
```

Supported OpenAI parameters:

- `messages` (required): Array of message objects with `role` and `content`
- `model` (optional): Model ID to use (get available models from `/v1/models`)
- `stream` (optional): Set to `true` for streaming responses
- `temperature`, `max_tokens`, `top_p`, `frequency_penalty`, `presence_penalty`, `stop`, `n` (accepted but may not affect behavior)

**Note:** Use actual model IDs from `/v1/models` endpoint (e.g., `gpt-4o`, `gpt-4`, `claude-sonnet-4.5`, etc.)

---

## Configuration (VS Code settings)

Search for `Copilot Connect` in VS Code settings or use these keys:

- `copilotConnect.port` (number, default `1288`)
- `copilotConnect.defaultModel` (string)
- `copilotConnect.additionalContext` (string)
- `copilotConnect.language` (`"en"` or `"zh"`)

Change port requires restarting the bridge.

---

## Testing

Test scripts and suites are under the `test/` directory.

```bash
# run a simple comparison test (needs reference bridge on 1287)
python3 test/compare_bridges.py

# run the comprehensive suite
python3 test/comprehensive_test.py

# test OpenAI API compatible endpoints
python3 test/openai_api_test.py

# test with curl
./test/openai_curl_examples.sh

# test with OpenAI client library (requires: pip install openai)
python3 test/openai_client_example.py
```

📊 **See [TEST_RESULTS.md](./TEST_RESULTS.md) for detailed test results and compatibility information.**

---

## Troubleshooting

- Bridge not starting: check port usage and VS Code Developer Console for errors.
- No models: ensure GitHub Copilot is installed, active and signed in.
- Session missing: sessions are in-memory and cleared on restart; use the returned sessionId.
- Extension updates not applied: reload the VS Code window after installing a new VSIX.

---

## File layout (important files)

- `src/` — extension and server source code
- `dist/` — compiled output
- `test/` — test suites and scripts
- `scripts/` — helper scripts (install, diagnostics)
- `LICENSE.md` — license
- `README.md` — this file

---

## License

This project is released under the MIT License. See `LICENSE.md` for details.

---

## Author

Tony Xu — tony@tarch.ca

---

## Version

1.2.0

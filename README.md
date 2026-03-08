# Copilot Connect (Copilot 信使)

A VS Code extension that exposes GitHub Copilot through a local HTTP server with OpenAI-compatible API endpoints. This allows external applications and tools to use Copilot's capabilities through the standard OpenAI API format.

## Features

- Local HTTP server for Copilot (default port: 1288)
- OpenAI-compatible `/v1/models` endpoint for model discovery
- OpenAI-compatible `/v1/chat/completions` endpoint with streaming support
- Tool calling support (`tools` / `tool_choice` parameters)
- **Echo mode** — test integrations without consuming real Copilot requests
- Health check endpoint with current mode and version
- `GET/POST /v1/mode` endpoint for programmatic Echo/Bridge switching
- VS Code status bar integration (dark orange = Echo mode)

## Installation

### From VSIX (recommended)

1. Build or obtain `copilot-connect-1.3.1.vsix`
2. In VS Code: `Cmd+Shift+P` → `Extensions: Install from VSIX...` → select the VSIX file
3. Reload window: `Cmd+Shift+P` → `Developer: Reload Window`

### From source

```bash
npm install
npm run compile
npm run package   # creates copilot-connect-1.3.1.vsix
```

Note: After installing or updating the extension you must reload the VS Code window.

## Quick Start

1. Start VS Code (the extension auto-starts)
2. Click the status bar item to open the Copilot Connect menu
3. Use the menu to start/stop the server, change port, or select default model

The status bar shows the current state and port (e.g., `Running :1288`).

## API Usage

Base URL: `http://localhost:1288`

### Health Check

```bash
curl http://localhost:1288/health
# {"status":"ok","port":1288,"version":"1.3.1","mode":"bridge"}
```

### List Models

```bash
curl http://localhost:1288/v1/models
```

Returns OpenAI-compatible format:

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

### Chat Completions (non-streaming)

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

### Chat Completions (streaming)

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

Returns SSE stream with OpenAI format chunks ending with `data: [DONE]`.

### Supported Parameters

- `messages` (required): Array of message objects with `role` and `content`
- `model` (optional): Model ID to use (see `GET /v1/models` for available IDs)
- `stream` (optional): Set to `true` for SSE streaming responses
- `stream_options` (optional): `{"include_usage":true}` appends a usage chunk before `[DONE]`
- `n` (optional): Number of independent completions to return
- `response_format` (optional): `{"type":"json_object"}` enforces JSON output
- `tools` / `tool_choice` (optional): Function calling (supported by `gpt-4o`, `gpt-4.1`)
- `temperature`, `max_tokens`, `max_completion_tokens`, `top_p`, `stop` (forwarded; partial effect)

## Echo Mode

Echo mode returns a `[Echo] <user message>` response with the **same JSON/SSE structure** as a
real reply — no Copilot tokens consumed. Useful for testing integrations.

```bash
# Enable echo mode
curl -X POST http://localhost:1288/v1/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"echo"}'

# Check current mode
curl http://localhost:1288/v1/mode

# Disable echo mode (return to bridge)
curl -X POST http://localhost:1288/v1/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"bridge"}'
```

Alternatively: status bar menu → _Switch to Echo Mode_, or Command Palette → `Copilot Connect: Toggle Echo Mode`.

The status bar turns **dark orange** while Echo mode is active. The extension always starts in Bridge mode.

## Configuration

Configure in VS Code settings under `Copilot Connect`:

- `port` (number, default `1288`): Server port
- `defaultModel` (string): Default model ID (empty for auto-select)
- `additionalContext` (string): Context prepended to all requests
- `language` (`"en"` or `"zh"`): UI language preference

Changing port requires restarting the server.

## Testing

```bash
# Run tests
npm test

# Watch mode for development
npm run test:dev
```

## Troubleshooting

- Server not starting: Check port usage and VS Code Developer Console for errors
- No models: Ensure GitHub Copilot is installed, active, and signed in
- Extension updates not applied: Reload the VS Code window after installing a new VSIX

## License

MIT License - see LICENSE.md for details

## Author

Tony Xu — tony@tarch.ca

## Version

1.3.1

# Copilot Connect (Copilot 信使)

A VS Code extension that exposes GitHub Copilot through a local HTTP server with OpenAI-compatible API endpoints. This allows external applications and tools to use Copilot's capabilities through the standard OpenAI API format.

## Features

- Local HTTP server for Copilot (default port: 1288)
- OpenAI-compatible `/v1/models` endpoint for model discovery
- OpenAI-compatible `/v1/chat/completions` endpoint with streaming support
- Stateless API design compatible with OpenAI clients
- Health check endpoint for monitoring
- VS Code status bar integration for easy management

## Installation

### From VSIX (recommended)

1. Build or obtain `copilot-connect-1.2.0.vsix`
2. In VS Code: `Cmd+Shift+P` → `Extensions: Install from VSIX...` → select the VSIX file
3. Reload window: `Cmd+Shift+P` → `Developer: Reload Window`

### From source

```bash
npm install
npm run compile
npm run package   # creates copilot-connect-1.2.0.vsix
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
- `model` (optional): Model ID to use
- `stream` (optional): Set to `true` for streaming responses
- `temperature`, `max_tokens`, `top_p`, `frequency_penalty`, `presence_penalty`, `stop`, `n` (accepted but may not affect behavior)

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

1.2.0

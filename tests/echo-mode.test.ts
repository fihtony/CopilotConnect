import { test } from "node:test";
import assert from "node:assert";
import { startBridge } from "../dist/server.js";
import type { ChatMessage, ChatResult, RequestOptions, ModelInfo } from "../dist/server.js";

// Port range: 1470–1499 (reserved for echo-mode tests)
let testPort = 1470;
const getTestPort = () => testPort++;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

async function chatPost(baseUrl: string, body: object): Promise<Response> {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function setMode(baseUrl: string, mode: "echo" | "bridge"): Promise<void> {
  await fetch(`${baseUrl}/v1/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

// ─────────────────────────────────────────────────────────────
// 1. Non-streaming: echo response shape == bridge response shape
// ─────────────────────────────────────────────────────────────

test("echo non-streaming: response structure matches bridge mode", async () => {
  const port = getTestPort();
  let handlerCallCount = 0;

  const mockHandler = async (): Promise<ChatResult> => {
    handlerCallCount++;
    return { content: "Real bridge response", finish_reason: "stop" };
  };

  const bridge = await startBridge(port, undefined, mockHandler);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const payload = { model: "gpt-4o", messages: [{ role: "user", content: "Hello from bridge" }] };

    // — Bridge mode response —
    const bridgeResp = await chatPost(baseUrl, payload);
    assert.strictEqual(bridgeResp.status, 200, "bridge status 200");
    const bridgeData = await bridgeResp.json();

    // — Switch to echo mode via API —
    const modeResp = await fetch(`${baseUrl}/v1/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "echo" }),
    });
    assert.strictEqual(modeResp.status, 200, "mode switch status 200");
    const modeData = await modeResp.json();
    assert.strictEqual(modeData.mode, "echo", "mode is echo");

    // — Echo mode response —
    const echoResp = await chatPost(baseUrl, { ...payload, messages: [{ role: "user", content: "Hello from echo" }] });
    assert.strictEqual(echoResp.status, 200, "echo status 200");
    const echoData = await echoResp.json();

    // Top-level fields must match
    assert.strictEqual(echoData.object, bridgeData.object, "object field matches");
    assert.strictEqual(typeof echoData.id, "string", "id is string");
    assert.ok(echoData.id.startsWith("chatcmpl-"), "id has chatcmpl- prefix");
    assert.strictEqual(typeof echoData.created, "number", "created is number");
    assert.strictEqual(typeof echoData.model, "string", "model is string");

    // choices array shape
    assert.ok(Array.isArray(echoData.choices), "choices is array");
    assert.strictEqual(echoData.choices.length, bridgeData.choices.length, "same number of choices");
    assert.strictEqual(echoData.choices[0].index, 0, "index 0");
    assert.strictEqual(echoData.choices[0].message.role, "assistant", "role is assistant");
    assert.strictEqual(typeof echoData.choices[0].message.content, "string", "content is string");
    assert.strictEqual(echoData.choices[0].finish_reason, "stop", "finish_reason is stop");

    // usage shape
    assert.ok(echoData.usage, "usage present");
    assert.strictEqual(typeof echoData.usage.prompt_tokens, "number", "prompt_tokens is number");
    assert.strictEqual(typeof echoData.usage.completion_tokens, "number", "completion_tokens is number");
    assert.strictEqual(typeof echoData.usage.total_tokens, "number", "total_tokens is number");

    // Echo content should echo back the user message
    assert.ok(echoData.choices[0].message.content.includes("Hello from echo"), "echo content contains user message");

    // Handler must NOT have been called in echo mode
    assert.strictEqual(handlerCallCount, 1, "handler called only once (bridge mode)");

    console.log("[echo-mode] Non-streaming structure comparison PASSED");
  } finally {
    bridge.stop();
  }
});

// ─────────────────────────────────────────────────────────────
// 2. Streaming: echo SSE format matches bridge SSE format
// ─────────────────────────────────────────────────────────────

test("echo streaming: SSE format matches bridge mode", async () => {
  const port = getTestPort();
  let streamHandlerCalled = false;

  const mockStreamHandler = async (
    _messages: ChatMessage[],
    _modelId: string | null,
    _options: RequestOptions,
    onChunk: (delta: any) => void,
  ) => {
    streamHandlerCalled = true;
    onChunk({ content: "Bridge " });
    onChunk({ content: "response" });
    return { finish_reason: "stop" };
  };

  const bridge = await startBridge(port, undefined, undefined, mockStreamHandler);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const payload = { model: "gpt-4o", messages: [{ role: "user", content: "Stream hello" }], stream: true };

    // — Bridge streaming —
    const bridgeResp = await chatPost(baseUrl, payload);
    assert.strictEqual(bridgeResp.status, 200, "bridge stream status 200");
    assert.ok(bridgeResp.headers.get("content-type")?.includes("text/event-stream"), "bridge SSE content-type");
    const bridgeText = await bridgeResp.text();
    assert.ok(bridgeText.includes("[DONE]"), "bridge stream ends with DONE");
    assert.ok(bridgeText.includes("chat.completion.chunk"), "bridge stream has chunk objects");

    // — Enable echo mode —
    await setMode(baseUrl, "echo");

    // — Echo streaming —
    const echoResp = await chatPost(baseUrl, { ...payload, messages: [{ role: "user", content: "Echo stream" }] });
    assert.strictEqual(echoResp.status, 200, "echo stream status 200");
    assert.ok(echoResp.headers.get("content-type")?.includes("text/event-stream"), "echo SSE content-type");

    const echoText = await echoResp.text();
    assert.ok(echoText.includes("[DONE]"), "echo stream ends with DONE");
    assert.ok(echoText.includes("chat.completion.chunk"), "echo stream has chunk objects");
    assert.ok(echoText.includes("Echo stream"), "echo stream contains user message");

    // Parse SSE lines and validate chunk structures
    const echoChunks = echoText
      .split("\n")
      .filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice("data:".length).trim()));

    assert.ok(echoChunks.length >= 3, "at least 3 SSE chunks (role, content, finish)");
    // First chunk: role opener
    assert.strictEqual(echoChunks[0].object, "chat.completion.chunk", "object field");
    assert.ok(Array.isArray(echoChunks[0].choices), "choices array");
    assert.strictEqual(echoChunks[0].choices[0].delta.role, "assistant", "first delta has role");
    // Last content chunk: finish_reason stop
    const finishChunk = echoChunks[echoChunks.length - 1];
    assert.strictEqual(finishChunk.choices[0].finish_reason, "stop", "last chunk has finish_reason stop");

    // Stream handler should only have been called in bridge mode
    assert.ok(streamHandlerCalled, "stream handler called in bridge mode");

    console.log("[echo-mode] Streaming SSE format comparison PASSED");
  } finally {
    bridge.stop();
  }
});

// ─────────────────────────────────────────────────────────────
// 3. Models endpoint uses cached models in echo mode
// ─────────────────────────────────────────────────────────────

test("echo models: returns cached models from bridge mode", async () => {
  const port = getTestPort();
  const fakeModels: ModelInfo[] = [
    { id: "gpt-cached-1", name: "Cached Model 1", vendor: "copilot" },
    { id: "gpt-cached-2", name: "Cached Model 2", vendor: "copilot" },
  ];
  let providerCallCount = 0;

  const mockModelProvider = async (): Promise<ModelInfo[]> => {
    providerCallCount++;
    return fakeModels;
  };

  const bridge = await startBridge(port, mockModelProvider);
  const baseUrl = `http://127.0.0.1:${port}`;

  // Small delay to let startup cache prime
  await new Promise((r) => setTimeout(r, 100));

  try {
    // Warm cache via real call in bridge mode
    const bridgeModelsResp = await fetch(`${baseUrl}/v1/models`);
    const bridgeModels = await bridgeModelsResp.json();
    assert.strictEqual(bridgeModels.data.length, 2, "bridge mode returns 2 models");

    // Switch to echo mode
    await setMode(baseUrl, "echo");

    // Echo mode should return the same cached models
    const echoModelsResp = await fetch(`${baseUrl}/v1/models`);
    const echoModels = await echoModelsResp.json();

    assert.strictEqual(echoModelsResp.status, 200, "echo models status 200");
    assert.strictEqual(echoModels.object, "list", "object is list");
    assert.ok(Array.isArray(echoModels.data), "data is array");
    assert.strictEqual(echoModels.data.length, 2, "same number of models as cached");
    assert.strictEqual(echoModels.data[0].id, "gpt-cached-1", "first model id matches");
    assert.strictEqual(echoModels.data[1].id, "gpt-cached-2", "second model id matches");

    console.log("[echo-mode] Model cache PASSED, provider called:", providerCallCount, "times");
  } finally {
    bridge.stop();
  }
});

// ─────────────────────────────────────────────────────────────
// 4. Mode toggle — API endpoint
// ─────────────────────────────────────────────────────────────

test("mode API: GET and POST /v1/mode", async () => {
  const port = getTestPort();
  const bridge = await startBridge(port);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Default mode is bridge
    const getResp1 = await fetch(`${baseUrl}/v1/mode`);
    const mode1 = await getResp1.json();
    assert.strictEqual(mode1.mode, "bridge", "default mode is bridge");

    // Switch to echo
    const postResp1 = await fetch(`${baseUrl}/v1/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "echo" }),
    });
    const mode2 = await postResp1.json();
    assert.strictEqual(mode2.mode, "echo", "POST returns echo mode");

    // GET reflects the change
    const getResp2 = await fetch(`${baseUrl}/v1/mode`);
    const mode3 = await getResp2.json();
    assert.strictEqual(mode3.mode, "echo", "GET returns updated echo mode");

    // Switch back to bridge
    const postResp2 = await fetch(`${baseUrl}/v1/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "bridge" }),
    });
    const mode4 = await postResp2.json();
    assert.strictEqual(mode4.mode, "bridge", "switch back to bridge");

    // Invalid mode returns 400
    const badResp = await fetch(`${baseUrl}/v1/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "invalid" }),
    });
    assert.strictEqual(badResp.status, 400, "invalid mode returns 400");

    console.log("[echo-mode] Mode API PASSED");
  } finally {
    bridge.stop();
  }
});

// ─────────────────────────────────────────────────────────────
// 5. Echo mode: n parameter works correctly
// ─────────────────────────────────────────────────────────────

test("echo non-streaming: n parameter produces multiple choices", async () => {
  const port = getTestPort();
  const bridge = await startBridge(port);
  const baseUrl = `http://127.0.0.1:${port}`;

  // Enable echo mode via the BridgeControl API
  bridge.setEchoMode(true);

  try {
    const resp = await chatPost(baseUrl, {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Multi choice test" }],
      n: 3,
    });
    assert.strictEqual(resp.status, 200, "status 200");
    const data = await resp.json();
    assert.strictEqual(data.choices.length, 3, "3 choices returned");
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(data.choices[i].index, i, `choice index ${i}`);
      assert.strictEqual(data.choices[i].message.role, "assistant", `choice ${i} role`);
      assert.ok(data.choices[i].message.content.includes("Multi choice test"), `choice ${i} echoes user message`);
      assert.strictEqual(data.choices[i].finish_reason, "stop", `choice ${i} finish_reason`);
    }
    console.log("[echo-mode] n=3 PASSED");
  } finally {
    bridge.stop();
  }
});

// ─────────────────────────────────────────────────────────────
// 6. Echo streaming: stream_options.include_usage sends usage chunk
// ─────────────────────────────────────────────────────────────

test("echo streaming: stream_options.include_usage appends usage chunk", async () => {
  const port = getTestPort();
  const bridge = await startBridge(port);
  bridge.setEchoMode(true);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const resp = await chatPost(baseUrl, {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Usage test" }],
      stream: true,
      stream_options: { include_usage: true },
    });

    assert.strictEqual(resp.status, 200, "status 200");
    const text = await resp.text();
    assert.ok(text.includes("[DONE]"), "stream ends with DONE");

    // Find the usage chunk (choices: [], usage: {...})
    const lines = text
      .split("\n")
      .filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
      .map((l) => JSON.parse(l.slice("data:".length).trim()));

    const usageChunk = lines.find((c) => Array.isArray(c.choices) && c.choices.length === 0 && c.usage);
    assert.ok(usageChunk, "usage chunk present");
    assert.strictEqual(typeof usageChunk.usage.prompt_tokens, "number", "prompt_tokens");
    assert.strictEqual(typeof usageChunk.usage.completion_tokens, "number", "completion_tokens");
    assert.strictEqual(typeof usageChunk.usage.total_tokens, "number", "total_tokens");

    console.log("[echo-mode] include_usage PASSED");
  } finally {
    bridge.stop();
  }
});

// ─────────────────────────────────────────────────────────────
// 7. BridgeControl.setEchoMode and getEchoMode round-trip
// ─────────────────────────────────────────────────────────────

test("BridgeControl: setEchoMode / getEchoMode round-trip", async () => {
  const port = getTestPort();
  const bridge = await startBridge(port);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    assert.strictEqual(bridge.getEchoMode(), false, "initial mode is bridge");

    bridge.setEchoMode(true);
    assert.strictEqual(bridge.getEchoMode(), true, "mode is echo after set");

    // API GET should reflect the programmatic change
    const modeResp = await fetch(`${baseUrl}/v1/mode`);
    const modeData = await modeResp.json();
    assert.strictEqual(modeData.mode, "echo", "API GET reflects programmatic echo set");

    bridge.setEchoMode(false);
    assert.strictEqual(bridge.getEchoMode(), false, "mode is bridge after reset");

    const modeResp2 = await fetch(`${baseUrl}/v1/mode`);
    const modeData2 = await modeResp2.json();
    assert.strictEqual(modeData2.mode, "bridge", "API GET reflects programmatic bridge set");

    console.log("[echo-mode] BridgeControl round-trip PASSED");
  } finally {
    bridge.stop();
  }
});

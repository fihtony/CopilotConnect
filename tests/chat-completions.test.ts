import { test } from "node:test";
import assert from "node:assert";
import { startBridge } from "../dist/server.js";

// Each test file gets a unique port range
let testPort = 1420;

function getTestPort() {
  return testPort++;
}

async function makeRequest(baseUrl: string, path: string, method = "GET", body?: any) {
  const url = `${baseUrl}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  return response;
}

test("v1/chat/completions requires messages array", async (t) => {
  const TEST_PORT = getTestPort();
  const stopBridge = await startBridge(TEST_PORT);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/chat/completions", "POST", {});
    const data = await response.json();

    assert.strictEqual(response.status, 400);
    assert.ok(data.error);
    assert.strictEqual(data.error.type, "invalid_request_error");
    assert.ok(data.error.message.includes("messages"));
  } finally {
    await stopBridge();
  }
});

test("v1/chat/completions rejects empty messages array", async (t) => {
  const TEST_PORT = getTestPort();
  const stopBridge = await startBridge(TEST_PORT);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/chat/completions", "POST", { messages: [] });
    const data = await response.json();

    assert.strictEqual(response.status, 400);
    assert.ok(data.error);
  } finally {
    await stopBridge();
  }
});

test("v1/chat/completions returns OpenAI format response", async (t) => {
  const TEST_PORT = getTestPort();
  const mockChatHandler = async (_prompt: string, _context: string | null, _modelId: string | null) => {
    return "Test response";
  };

  const stopBridge = await startBridge(TEST_PORT, undefined, mockChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [{ role: "user", content: "Hello" }],
    });
    const data = await response.json();

    assert.strictEqual(response.status, 200);
    assert.ok(data.id);
    assert.strictEqual(data.object, "chat.completion");
    assert.ok(typeof data.created === "number");
    assert.ok(data.model);
    assert.ok(Array.isArray(data.choices));
    assert.strictEqual(data.choices.length, 1);
    assert.strictEqual(data.choices[0].message.role, "assistant");
    assert.strictEqual(data.choices[0].message.content, "Test response");
    assert.strictEqual(data.choices[0].finish_reason, "stop");
    assert.ok(data.usage);
  } finally {
    await stopBridge();
  }
});

test("v1/chat/completions includes system message in context", async (t) => {
  const TEST_PORT = getTestPort();
  let receivedContext = "";

  const mockChatHandler = async (_prompt: string, context: string | null, _modelId: string | null) => {
    receivedContext = context || "";
    return "Response";
  };

  const stopBridge = await startBridge(TEST_PORT, undefined, mockChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "Hello" },
      ],
    });

    assert.ok(receivedContext.includes("helpful assistant"));
  } finally {
    await stopBridge();
  }
});

test("v1/chat/completions includes model parameter", async (t) => {
  const TEST_PORT = getTestPort();
  let receivedModelId: string | null = null;

  const mockChatHandler = async (_prompt: string, _context: string | null, modelId: string | null) => {
    receivedModelId = modelId;
    return "Response";
  };

  const stopBridge = await startBridge(TEST_PORT, undefined, mockChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [{ role: "user", content: "Hello" }],
      model: "test-model",
    });

    assert.strictEqual(receivedModelId, "test-model");
  } finally {
    await stopBridge();
  }
});

test("v1/chat/completions handles streaming requests", async (t) => {
  const TEST_PORT = getTestPort();
  const mockStreamChatHandler = async (
    _prompt: string,
    _context: string | null,
    _modelId: string | null,
    onChunk: (chunk: string) => void
  ) => {
    onChunk("Hello");
    onChunk(" world");
  };

  const stopBridge = await startBridge(TEST_PORT, undefined, undefined, mockStreamChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [{ role: "user", content: "Say hello" }],
      stream: true,
    });

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get("content-type"), "text/event-stream");

    const text = await response.text();
    assert.ok(text.includes("data:"));
    assert.ok(text.includes("chat.completion.chunk"));
    assert.ok(text.includes("[DONE]"));
  } finally {
    await stopBridge();
  }
});

test("v1/chat/completions returns error when handler fails", async (t) => {
  const TEST_PORT = getTestPort();
  const mockChatHandler = async () => {
    throw new Error("Test error");
  };

  const stopBridge = await startBridge(TEST_PORT, undefined, mockChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [{ role: "user", content: "Hello" }],
    });
    const data = await response.json();

    assert.strictEqual(response.status, 500);
    assert.ok(data.error);
    assert.strictEqual(data.error.type, "server_error");
    assert.ok(data.error.message.includes("Test error"));
  } finally {
    await stopBridge();
  }
});

test("v1/chat/completions streaming handles errors", async (t) => {
  const TEST_PORT = getTestPort();
  const mockStreamChatHandler = async () => {
    throw new Error("Stream error");
  };

  const stopBridge = await startBridge(TEST_PORT, undefined, undefined, mockStreamChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    });

    const text = await response.text();
    assert.ok(text.includes("error"));
    assert.ok(text.includes("Stream error"));
  } finally {
    await stopBridge();
  }
});

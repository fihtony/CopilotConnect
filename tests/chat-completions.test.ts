import { test } from "node:test";
import assert from "node:assert";
import { startBridge } from "../dist/server.js";
import type { ChatMessage, RequestOptions, ChatResult } from "../dist/server.js";

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
  const bridge = await startBridge(TEST_PORT);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/chat/completions", "POST", {});
    const data = await response.json();

    assert.strictEqual(response.status, 400);
    assert.ok(data.error);
    assert.strictEqual(data.error.type, "invalid_request_error");
    assert.ok(data.error.message.includes("messages"));
  } finally {
    bridge.stop();
  }
});

test("v1/chat/completions rejects empty messages array", async (t) => {
  const TEST_PORT = getTestPort();
  const bridge = await startBridge(TEST_PORT);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/chat/completions", "POST", { messages: [] });
    const data = await response.json();

    assert.strictEqual(response.status, 400);
    assert.ok(data.error);
  } finally {
    bridge.stop();
  }
});

test("v1/chat/completions returns OpenAI format response", async (t) => {
  const TEST_PORT = getTestPort();
  const mockChatHandler = async (_messages: ChatMessage[], _modelId: string | null, _options: RequestOptions): Promise<ChatResult> => {
    return { content: "Test response", finish_reason: "stop" };
  };

  const bridge = await startBridge(TEST_PORT, undefined, mockChatHandler);
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
    bridge.stop();
  }
});

test("v1/chat/completions passes full messages array to handler", async (t) => {
  const TEST_PORT = getTestPort();
  let receivedMessages: ChatMessage[] = [];

  const mockChatHandler = async (messages: ChatMessage[], _modelId: string | null, _options: RequestOptions): Promise<ChatResult> => {
    receivedMessages = messages;
    return { content: "Response", finish_reason: "stop" };
  };

  const bridge = await startBridge(TEST_PORT, undefined, mockChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "Hello" },
      ],
    });

    assert.strictEqual(receivedMessages.length, 2);
    assert.strictEqual(receivedMessages[0].role, "system");
    assert.strictEqual(receivedMessages[0].content, "You are a helpful assistant");
    assert.strictEqual(receivedMessages[1].role, "user");
    assert.strictEqual(receivedMessages[1].content, "Hello");
  } finally {
    bridge.stop();
  }
});

test("v1/chat/completions passes model parameter to handler", async (t) => {
  const TEST_PORT = getTestPort();
  let receivedModelId: string | null = null;

  const mockChatHandler = async (_messages: ChatMessage[], modelId: string | null, _options: RequestOptions): Promise<ChatResult> => {
    receivedModelId = modelId;
    return { content: "Response", finish_reason: "stop" };
  };

  const bridge = await startBridge(TEST_PORT, undefined, mockChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [{ role: "user", content: "Hello" }],
      model: "test-model",
    });

    assert.strictEqual(receivedModelId, "test-model");
  } finally {
    bridge.stop();
  }
});

test("v1/chat/completions passes all OpenAI parameters to handler", async (t) => {
  const TEST_PORT = getTestPort();
  let receivedOptions: RequestOptions = {};

  const mockChatHandler = async (_messages: ChatMessage[], _modelId: string | null, options: RequestOptions): Promise<ChatResult> => {
    receivedOptions = options;
    return { content: "Response", finish_reason: "stop" };
  };

  const bridge = await startBridge(TEST_PORT, undefined, mockChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [{ role: "user", content: "Hello" }],
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 100,
      max_completion_tokens: 200,
      stop: ["STOP"],
      presence_penalty: 0.5,
      frequency_penalty: 0.3,
      seed: 42,
      user: "user-123",
    });

    assert.strictEqual(receivedOptions.temperature, 0.7);
    assert.strictEqual(receivedOptions.top_p, 0.9);
    assert.strictEqual(receivedOptions.max_tokens, 100);
    assert.strictEqual(receivedOptions.max_completion_tokens, 200);
    assert.deepStrictEqual(receivedOptions.stop, ["STOP"]);
    assert.strictEqual(receivedOptions.presence_penalty, 0.5);
    assert.strictEqual(receivedOptions.frequency_penalty, 0.3);
    assert.strictEqual(receivedOptions.seed, 42);
    assert.strictEqual(receivedOptions.user, "user-123");
  } finally {
    bridge.stop();
  }
});

test("v1/chat/completions passes tools and tool_choice to handler", async (t) => {
  const TEST_PORT = getTestPort();
  let receivedOptions: RequestOptions = {};

  const mockChatHandler = async (_messages: ChatMessage[], _modelId: string | null, options: RequestOptions): Promise<ChatResult> => {
    receivedOptions = options;
    return { content: "Response", finish_reason: "stop" };
  };

  const bridge = await startBridge(TEST_PORT, undefined, mockChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  const sampleTool = {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather for a location",
      parameters: {
        type: "object",
        properties: { location: { type: "string" } },
        required: ["location"],
      },
    },
  };

  try {
    await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [{ role: "user", content: "What's the weather?" }],
      tools: [sampleTool],
      tool_choice: "auto",
    });

    assert.ok(Array.isArray(receivedOptions.tools));
    assert.strictEqual(receivedOptions.tools!.length, 1);
    assert.strictEqual(receivedOptions.tools![0].function.name, "get_weather");
    assert.strictEqual(receivedOptions.tool_choice, "auto");
  } finally {
    bridge.stop();
  }
});

test("v1/chat/completions returns tool_calls in response", async (t) => {
  const TEST_PORT = getTestPort();
  const mockChatHandler = async (_messages: ChatMessage[], _modelId: string | null, _options: RequestOptions): Promise<ChatResult> => {
    return {
      content: null,
      finish_reason: "tool_calls",
      tool_calls: [
        {
          id: "call_abc123",
          type: "function",
          function: { name: "get_weather", arguments: '{"location":"NYC"}' },
        },
      ],
    };
  };

  const bridge = await startBridge(TEST_PORT, undefined, mockChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [{ role: "user", content: "What's the weather in NYC?" }],
      tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
    });
    const data = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(data.choices[0].finish_reason, "tool_calls");
    assert.ok(Array.isArray(data.choices[0].message.tool_calls));
    assert.strictEqual(data.choices[0].message.tool_calls[0].id, "call_abc123");
    assert.strictEqual(data.choices[0].message.tool_calls[0].function.name, "get_weather");
  } finally {
    bridge.stop();
  }
});

test("v1/chat/completions n parameter returns multiple choices", async (t) => {
  const TEST_PORT = getTestPort();
  let callCount = 0;

  const mockChatHandler = async (_messages: ChatMessage[], _modelId: string | null, _options: RequestOptions): Promise<ChatResult> => {
    callCount++;
    return { content: `Response ${callCount}`, finish_reason: "stop" };
  };

  const bridge = await startBridge(TEST_PORT, undefined, mockChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [{ role: "user", content: "Hello" }],
      n: 3,
    });
    const data = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(data.choices.length, 3);
    assert.strictEqual(callCount, 3);
  } finally {
    bridge.stop();
  }
});

test("v1/chat/completions passes response_format to handler", async (t) => {
  const TEST_PORT = getTestPort();
  let receivedOptions: RequestOptions = {};

  const mockChatHandler = async (_messages: ChatMessage[], _modelId: string | null, options: RequestOptions): Promise<ChatResult> => {
    receivedOptions = options;
    return { content: '{"result": "ok"}', finish_reason: "stop" };
  };

  const bridge = await startBridge(TEST_PORT, undefined, mockChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [{ role: "user", content: "Return JSON" }],
      response_format: { type: "json_object" },
    });

    assert.deepStrictEqual(receivedOptions.response_format, { type: "json_object" });
  } finally {
    bridge.stop();
  }
});

test("v1/chat/completions handles streaming requests", async (t) => {
  const TEST_PORT = getTestPort();
  const mockStreamChatHandler = async (
    _messages: ChatMessage[],
    _modelId: string | null,
    _options: RequestOptions,
    onChunk: (delta: any) => void,
  ) => {
    onChunk({ content: "Hello" });
    onChunk({ content: " world" });
    return { finish_reason: "stop" };
  };

  const bridge = await startBridge(TEST_PORT, undefined, undefined, mockStreamChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [{ role: "user", content: "Say hello" }],
      stream: true,
    });

    assert.strictEqual(response.status, 200);
    assert.ok(response.headers.get("content-type")?.includes("text/event-stream"));

    const text = await response.text();
    assert.ok(text.includes("data:"));
    assert.ok(text.includes("chat.completion.chunk"));
    assert.ok(text.includes("[DONE]"));
    assert.ok(text.includes("Hello"));
    assert.ok(text.includes(" world"));
  } finally {
    bridge.stop();
  }
});

test("v1/chat/completions streaming returns role in first chunk", async (t) => {
  const TEST_PORT = getTestPort();
  const mockStreamChatHandler = async (
    _messages: ChatMessage[],
    _modelId: string | null,
    _options: RequestOptions,
    onChunk: (delta: any) => void,
  ) => {
    onChunk({ content: "Hi" });
    return {};
  };

  const bridge = await startBridge(TEST_PORT, undefined, undefined, mockStreamChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    });

    const text = await response.text();
    const lines = text.split("\n").filter((l) => l.startsWith("data:") && l !== "data: [DONE]");
    const firstChunk = JSON.parse(lines[0].replace("data: ", ""));
    assert.strictEqual(firstChunk.choices[0].delta.role, "assistant");
  } finally {
    bridge.stop();
  }
});

test("v1/chat/completions streaming with stream_options.include_usage", async (t) => {
  const TEST_PORT = getTestPort();
  const mockStreamChatHandler = async (
    _messages: ChatMessage[],
    _modelId: string | null,
    _options: RequestOptions,
    onChunk: (delta: any) => void,
  ) => {
    onChunk({ content: "Hello" });
    return { finish_reason: "stop", usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } };
  };

  const bridge = await startBridge(TEST_PORT, undefined, undefined, mockStreamChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      stream_options: { include_usage: true },
    });

    const text = await response.text();
    // There should be a usage chunk (empty choices array with usage field)
    assert.ok(text.includes('"usage"'));
    assert.ok(text.includes('"prompt_tokens"'));
  } finally {
    bridge.stop();
  }
});

test("v1/chat/completions streaming passes tool_calls delta", async (t) => {
  const TEST_PORT = getTestPort();
  const mockStreamChatHandler = async (
    _messages: ChatMessage[],
    _modelId: string | null,
    _options: RequestOptions,
    onChunk: (delta: any) => void,
  ) => {
    onChunk({
      tool_calls: [
        {
          index: 0,
          id: "call_123",
          type: "function",
          function: { name: "get_weather", arguments: '{"location":"NYC"}' },
        },
      ],
    });
    return { finish_reason: "tool_calls" };
  };

  const bridge = await startBridge(TEST_PORT, undefined, undefined, mockStreamChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [{ role: "user", content: "What's the weather?" }],
      stream: true,
      tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
    });

    const text = await response.text();
    assert.ok(text.includes("tool_calls"));
    assert.ok(text.includes("get_weather"));
    // Final chunk should have finish_reason: tool_calls
    assert.ok(text.includes("tool_calls"));
  } finally {
    bridge.stop();
  }
});

test("v1/chat/completions returns error when handler fails", async (t) => {
  const TEST_PORT = getTestPort();
  const mockChatHandler = async (): Promise<ChatResult> => {
    throw new Error("Test error");
  };

  const bridge = await startBridge(TEST_PORT, undefined, mockChatHandler);
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
    bridge.stop();
  }
});

test("v1/chat/completions streaming handles errors", async (t) => {
  const TEST_PORT = getTestPort();
  const mockStreamChatHandler = async (): Promise<{ finish_reason?: string }> => {
    throw new Error("Stream error");
  };

  const bridge = await startBridge(TEST_PORT, undefined, undefined, mockStreamChatHandler);
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
    bridge.stop();
  }
});

test("v1/chat/completions fallback echo when no handler", async (t) => {
  const TEST_PORT = getTestPort();
  const bridge = await startBridge(TEST_PORT);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/chat/completions", "POST", {
      messages: [{ role: "user", content: "Hello world" }],
    });
    const data = await response.json();

    assert.strictEqual(response.status, 200);
    assert.ok(data.choices[0].message.content.includes("Hello world"));
  } finally {
    bridge.stop();
  }
});

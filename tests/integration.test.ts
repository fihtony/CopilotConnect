import { test } from "node:test";
import assert from "node:assert";
import { startBridge } from "../dist/server.js";
import type { ChatMessage, RequestOptions, ChatResult } from "../dist/server.js";

// Integration test - simulates real OpenAI client usage
test("integration: full OpenAI chat completion flow", async (t) => {
  const TEST_PORT = 1450;

  // Simulate a real chat handler
  const mockChatHandler = async (messages: ChatMessage[], modelId: string | null, _options: RequestOptions): Promise<ChatResult> => {
    const lastUser = messages.filter((m) => m.role === "user").pop();
    return { content: `Response to: ${lastUser?.content}`, finish_reason: "stop" };
  };

  const bridge = await startBridge(TEST_PORT, undefined, mockChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    // Test 1: Health check
    const healthResponse = await fetch(`${baseUrl}/health`);
    assert.strictEqual(healthResponse.status, 200);
    const healthData = await healthResponse.json();
    assert.strictEqual(healthData.status, "ok");
    console.log("Health check passed");

    // Test 2: List models
    const modelsResponse = await fetch(`${baseUrl}/v1/models`);
    assert.strictEqual(modelsResponse.status, 200);
    const modelsData = await modelsResponse.json();
    assert.strictEqual(modelsData.object, "list");
    assert.ok(Array.isArray(modelsData.data));
    assert.ok(modelsData.data.length > 0);
    console.log("Models list passed:", modelsData.data.length, "models");

    // Test 3: Non-streaming chat completion
    const chatResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Hello, how are you?" },
        ],
      }),
    });
    assert.strictEqual(chatResponse.status, 200);
    const chatData = await chatResponse.json();
    assert.strictEqual(chatData.object, "chat.completion");
    assert.ok(chatData.id);
    assert.ok(chatData.choices);
    assert.strictEqual(chatData.choices.length, 1);
    assert.strictEqual(chatData.choices[0].message.role, "assistant");
    assert.ok(chatData.choices[0].message.content);
    console.log("Non-streaming chat passed, response:", chatData.choices[0].message.content);

    // Test 4: Streaming chat completion
    const streamResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Count to 5" }],
        stream: true,
      }),
    });
    assert.strictEqual(streamResponse.status, 200);
    assert.ok(streamResponse.headers.get("content-type")?.includes("text/event-stream"));

    const streamText = await streamResponse.text();
    assert.ok(streamText.includes("data:"));
    assert.ok(streamText.includes("chat.completion.chunk"));
    assert.ok(streamText.includes("[DONE]"));
    console.log("Streaming chat passed, received", streamText.split("\n").length, "lines");

    // Test 5: Error handling - missing messages
    const errorResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o" }),
    });
    assert.strictEqual(errorResponse.status, 400);
    const errorData = await errorResponse.json();
    assert.ok(errorData.error);
    console.log("Error handling passed:", errorData.error.message);

    // Test 6: All parameters pass-through
    let capturedOptions: RequestOptions = {};
    const bridgeCapture = await startBridge(TEST_PORT + 100, undefined, async (_msgs, _id, opts) => {
      capturedOptions = opts;
      return { content: "ok", finish_reason: "stop" };
    });
    try {
      await fetch(`http://127.0.0.1:${TEST_PORT + 100}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          temperature: 0.5,
          top_p: 0.8,
          max_tokens: 50,
          max_completion_tokens: 100,
          n: 1,
          stop: ["\n"],
          presence_penalty: 0.1,
          frequency_penalty: 0.2,
          seed: 99,
          response_format: { type: "json_object" },
          user: "test-user",
        }),
      });
      assert.strictEqual(capturedOptions.temperature, 0.5);
      assert.strictEqual(capturedOptions.top_p, 0.8);
      assert.strictEqual(capturedOptions.max_tokens, 50);
      assert.strictEqual(capturedOptions.max_completion_tokens, 100);
      assert.strictEqual(capturedOptions.seed, 99);
      assert.deepStrictEqual(capturedOptions.stop, ["\n"]);
      assert.deepStrictEqual(capturedOptions.response_format, { type: "json_object" });
      assert.strictEqual(capturedOptions.user, "test-user");
      console.log("All parameters pass-through passed");
    } finally {
      bridgeCapture.stop();
    }

    console.log("All integration tests passed");
  } finally {
    bridge.stop();
  }
});

// Test with mock model provider
test("integration: with custom model provider", async (t) => {
  const TEST_PORT = 1451;

  const customModels = [
    { id: "custom-model-1", name: "Custom Model 1", vendor: "custom" },
    { id: "custom-model-2", name: "Custom Model 2", vendor: "custom" },
  ];

  const bridge = await startBridge(TEST_PORT, async () => customModels);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await fetch(`${baseUrl}/v1/models`);
    const data = await response.json();

    assert.strictEqual(data.data.length, 2);
    assert.strictEqual(data.data[0].id, "custom-model-1");
    assert.strictEqual(data.data[0].owned_by, "custom");
    console.log("Custom model provider passed:", data.data.length, "custom models");
  } finally {
    bridge.stop();
  }
});

// Test tool calling in non-streaming mode
test("integration: tool calling flow", async (t) => {
  const TEST_PORT = 1452;

  const mockChatHandler = async (messages: ChatMessage[], _modelId: string | null, _options: RequestOptions): Promise<ChatResult> => {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === "user" && lastMsg.content?.includes("weather")) {
      return {
        content: null,
        finish_reason: "tool_calls",
        tool_calls: [
          {
            id: "call_xyz",
            type: "function",
            function: { name: "get_weather", arguments: '{"location":"Tokyo"}' },
          },
        ],
      };
    }
    return { content: "The weather in Tokyo is sunny.", finish_reason: "stop" };
  };

  const bridge = await startBridge(TEST_PORT, undefined, mockChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    // Turn 1: user asks about weather → model calls tool
    const r1 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather",
              parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] },
            },
          },
        ],
        tool_choice: "auto",
      }),
    });
    const d1 = await r1.json();
    assert.strictEqual(d1.choices[0].finish_reason, "tool_calls");
    assert.strictEqual(d1.choices[0].message.tool_calls[0].function.name, "get_weather");
    console.log("Tool call turn 1 passed");

    // Turn 2: send tool result → model responds
    const r2 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "What's the weather in Tokyo?" },
          { role: "assistant", content: null, tool_calls: d1.choices[0].message.tool_calls },
          { role: "tool", tool_call_id: "call_xyz", content: '{"temperature":22,"condition":"sunny"}' },
        ],
      }),
    });
    const d2 = await r2.json();
    assert.strictEqual(d2.choices[0].finish_reason, "stop");
    assert.ok(d2.choices[0].message.content.includes("sunny"));
    console.log("Tool call turn 2 passed");
  } finally {
    bridge.stop();
  }
});

// Test multi-choice (n > 1)
test("integration: n parameter produces multiple choices", async (t) => {
  const TEST_PORT = 1453;
  let invocationCount = 0;

  const mockChatHandler = async (): Promise<ChatResult> => {
    invocationCount++;
    return { content: `Variation ${invocationCount}`, finish_reason: "stop" };
  };

  const bridge = await startBridge(TEST_PORT, undefined, mockChatHandler);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Tell me a joke" }],
        n: 3,
      }),
    });
    const data = await response.json();
    assert.strictEqual(data.choices.length, 3);
    assert.strictEqual(invocationCount, 3);
    assert.strictEqual(data.choices[0].index, 0);
    assert.strictEqual(data.choices[1].index, 1);
    assert.strictEqual(data.choices[2].index, 2);
    console.log("n=3 passed, got", data.choices.length, "choices");
  } finally {
    bridge.stop();
  }
});

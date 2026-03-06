import { test } from "node:test";
import assert from "node:assert";
import { startBridge } from "../dist/server.js";

// Integration test - simulates real OpenAI client usage
test("integration: full OpenAI chat completion flow", async (t) => {
  const TEST_PORT = 1430;

  // Simulate a real chat handler
  const mockChatHandler = async (prompt: string, context: string | null, modelId: string | null) => {
    // Simulate actual processing
    return `Response to: ${prompt}`;
  };

  const stopBridge = await startBridge(TEST_PORT, undefined, mockChatHandler);
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
    assert.strictEqual(streamResponse.headers.get("content-type"), "text/event-stream");

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

    console.log("All integration tests passed");
  } finally {
    await stopBridge();
  }
});

// Test with mock model provider
test("integration: with custom model provider", async (t) => {
  const TEST_PORT = 1431;

  const customModels = [
    { id: "custom-model-1", name: "Custom Model 1", vendor: "custom" },
    { id: "custom-model-2", name: "Custom Model 2", vendor: "custom" },
  ];

  const stopBridge = await startBridge(TEST_PORT, async () => customModels);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await fetch(`${baseUrl}/v1/models`);
    const data = await response.json();

    assert.strictEqual(data.data.length, 2);
    assert.strictEqual(data.data[0].id, "custom-model-1");
    assert.strictEqual(data.data[0].owned_by, "custom");
    console.log("Custom model provider passed:", data.data.length, "custom models");
  } finally {
    await stopBridge();
  }
});

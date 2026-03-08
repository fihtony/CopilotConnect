import { test } from "node:test";
import assert from "node:assert";
import { startBridge } from "../dist/server.js";

// Each test file gets a unique port range
let testPort = 1410;

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

test("v1/models endpoint returns OpenAI-compatible format", async (t) => {
  const TEST_PORT = getTestPort();
  const mockModelProvider = async () => [
    { id: "gpt-4", name: "GPT-4", vendor: "copilot" },
    { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo", vendor: "copilot" },
  ];

  const bridge = await startBridge(TEST_PORT, mockModelProvider);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/models");
    const data = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(data.object, "list");
    assert.ok(Array.isArray(data.data));

    // Check model structure
    const firstModel = data.data[0];
    assert.ok(firstModel.id);
    assert.strictEqual(firstModel.object, "model");
    assert.ok(typeof firstModel.created === "number");
    assert.ok(firstModel.owned_by);
  } finally {
    bridge.stop();
  }
});

test("v1/models endpoint returns fallback models when provider fails", async (t) => {
  const TEST_PORT = getTestPort();
  const mockModelProvider = async () => {
    throw new Error("Provider failed");
  };

  const bridge = await startBridge(TEST_PORT, mockModelProvider);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/models");
    const data = await response.json();

    assert.strictEqual(response.status, 200);
    assert.ok(Array.isArray(data.data));
    assert.ok(data.data.length > 0);
    assert.strictEqual(data.data[0].id, "default");
  } finally {
    bridge.stop();
  }
});

test("v1/models endpoint returns fallback when no provider", async (t) => {
  const TEST_PORT = getTestPort();
  const bridge = await startBridge(TEST_PORT);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/models");
    const data = await response.json();

    assert.strictEqual(response.status, 200);
    assert.ok(Array.isArray(data.data));
    assert.strictEqual(data.data[0].id, "default");
  } finally {
    bridge.stop();
  }
});

test("v1/models returns correct vendor from provider", async (t) => {
  const TEST_PORT = getTestPort();
  const mockModelProvider = async () => [
    { id: "test-model", name: "Test Model", vendor: "test-vendor", family: "test-family" },
  ];

  const bridge = await startBridge(TEST_PORT, mockModelProvider);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/v1/models");
    const data = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(data.data[0].owned_by, "test-vendor");
  } finally {
    bridge.stop();
  }
});

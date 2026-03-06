import { test } from "node:test";
import assert from "node:assert";
import { startBridge } from "../dist/server.js";

// Each test file gets a unique port range
let testPort = 1400;

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

test("health endpoint returns correct status", async (t) => {
  const TEST_PORT = getTestPort();
  const stopBridge = await startBridge(TEST_PORT);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/health");
    const data = await response.json();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(data.status, "ok");
    assert.strictEqual(data.port, TEST_PORT);
    assert.strictEqual(typeof data.version, "string");
  } finally {
    await stopBridge();
  }
});

test("health endpoint returns 200 status code", async (t) => {
  const TEST_PORT = getTestPort();
  const stopBridge = await startBridge(TEST_PORT);
  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  try {
    const response = await makeRequest(baseUrl, "/health");
    assert.strictEqual(response.status, 200);
  } finally {
    await stopBridge();
  }
});

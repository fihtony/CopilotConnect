/**
 * Live Integration Tests for CopilotConnect
 *
 * These tests run against a live CopilotConnect server (VS Code extension must be running).
 * They verify end-to-end behavior with real GitHub Copilot models.
 *
 * Prerequisites:
 *   - VS Code with CopilotConnect extension active on port 1288 (default)
 *   - GitHub Copilot installed and signed in
 *
 * Run:
 *   COPILOT_LIVE=1 node --test tests/live.test.ts
 *   or set PORT env var to override the server port.
 */

import { test, describe } from "node:test";
import assert from "node:assert";

const LIVE = process.env.COPILOT_LIVE === "1";
const BASE_URL = `http://127.0.0.1:${process.env.PORT || 1288}`;
const TIMEOUT_MS = 30_000;

// Free/included GitHub Copilot models to use for testing
const FREE_MODELS = ["gpt-5-mini", "gpt-4o", "gpt-4.1"];

// Skip all tests if not in live mode
function liveTest(name: string, fn: () => Promise<void>) {
  if (!LIVE) {
    test(`[SKIPPED – set COPILOT_LIVE=1] ${name}`, () => {});
    return;
  }
  test(name, { timeout: TIMEOUT_MS }, fn);
}

// ── Connectivity ──────────────────────────────────────────────────────────────

liveTest("live: health endpoint is reachable", async () => {
  const res = await fetch(`${BASE_URL}/health`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.status, "ok");
  assert.ok(typeof data.port === "number");
  assert.ok(data.mode === "echo" || data.mode === "bridge", `health.mode should be echo or bridge, got: ${data.mode}`);
  console.log(`  ✓ Server healthy at ${BASE_URL}, port=${data.port}, version=${data.version}, mode=${data.mode}`);
});

// ── Model Discovery ───────────────────────────────────────────────────────────

liveTest("live: GET /v1/models returns OpenAI-compatible list", async () => {
  const res = await fetch(`${BASE_URL}/v1/models`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.object, "list");
  assert.ok(Array.isArray(data.data) && data.data.length > 0);

  const first = data.data[0];
  assert.ok(first.id, "model has id");
  assert.strictEqual(first.object, "model");
  assert.ok(typeof first.created === "number");
  assert.ok(first.owned_by);

  console.log(`  ✓ ${data.data.length} models available:`);
  for (const m of data.data) {
    console.log(`    - ${m.id} (${m.owned_by})`);
  }
});

// ── Non-Streaming Completions ─────────────────────────────────────────────────

for (const model of FREE_MODELS) {
  liveTest(`live: non-streaming chat with model=${model}`, async () => {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a concise assistant. Reply in one short sentence." },
          { role: "user", content: "Say: Hello from CopilotConnect." },
        ],
        temperature: 0,
      }),
    });

    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = await res.json();

    assert.strictEqual(data.object, "chat.completion");
    assert.ok(data.id?.startsWith("chatcmpl-"));
    assert.ok(typeof data.created === "number");
    assert.ok(Array.isArray(data.choices) && data.choices.length === 1);
    assert.strictEqual(data.choices[0].message.role, "assistant");
    assert.ok(typeof data.choices[0].message.content === "string" && data.choices[0].message.content.length > 0);
    assert.ok(["stop", "length"].includes(data.choices[0].finish_reason));
    assert.ok(data.usage);

    console.log(`  ✓ model=${model}, finish_reason=${data.choices[0].finish_reason}`);
    console.log(`    response: "${data.choices[0].message.content.slice(0, 100)}"`);
  });
}

// ── Streaming Completions ─────────────────────────────────────────────────────

for (const model of FREE_MODELS) {
  liveTest(`live: streaming chat with model=${model}`, async () => {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Count from 1 to 3." }],
        stream: true,
        temperature: 0,
      }),
    });

    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get("content-type")?.includes("text/event-stream"));

    const rawText = await res.text();
    const lines = rawText.split("\n").filter((l) => l.startsWith("data:"));

    assert.ok(lines.length >= 2, "Expected at least 2 SSE lines");
    assert.strictEqual(lines[lines.length - 1].trim(), "data: [DONE]");

    // First content chunk should have role: assistant
    const firstChunk = JSON.parse(lines[0].replace("data: ", ""));
    assert.strictEqual(firstChunk.object, "chat.completion.chunk");
    assert.strictEqual(firstChunk.choices[0].delta.role, "assistant");

    // Collect all content
    let fullContent = "";
    let finalFinishReason: string | null = null;
    for (const line of lines) {
      if (line === "data: [DONE]") break;
      const chunk = JSON.parse(line.replace("data: ", ""));
      if (chunk.choices?.[0]?.delta?.content) {
        fullContent += chunk.choices[0].delta.content;
      }
      if (chunk.choices?.[0]?.finish_reason) {
        finalFinishReason = chunk.choices[0].finish_reason;
      }
    }

    assert.ok(fullContent.length > 0, "Expected non-empty streamed content");
    assert.ok(["stop", "length"].includes(finalFinishReason ?? ""), "Expected valid finish_reason");
    console.log(`  ✓ model=${model}, chunks=${lines.length - 1}, finish=${finalFinishReason}`);
    console.log(`    content: "${fullContent.slice(0, 100)}"`);
  });
}

// ── stream_options.include_usage ──────────────────────────────────────────────

liveTest("live: streaming with stream_options.include_usage", async () => {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Say hi." }],
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 10,
    }),
  });

  assert.strictEqual(res.status, 200);
  const rawText = await res.text();
  const lines = rawText.split("\n").filter((l) => l.startsWith("data:") && l !== "data: [DONE]");

  // Look for a chunk with usage field
  const usageChunks = lines
    .map((l) => {
      try {
        return JSON.parse(l.replace("data: ", ""));
      } catch {
        return null;
      }
    })
    .filter((c) => c?.usage !== undefined);

  assert.ok(usageChunks.length > 0, "Expected at least one chunk with usage field");
  const usageChunk = usageChunks[0];
  assert.ok(typeof usageChunk.usage.prompt_tokens === "number");
  assert.ok(typeof usageChunk.usage.completion_tokens === "number");
  console.log(`  ✓ usage chunk: ${JSON.stringify(usageChunk.usage)}`);
});

// ── n parameter (multiple completions) ───────────────────────────────────────

liveTest("live: n=2 returns two independent choices", async () => {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Say a single random word." }],
      n: 2,
      temperature: 1.0,
      max_completion_tokens: 10,
    }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.choices.length, 2);
  assert.strictEqual(data.choices[0].index, 0);
  assert.strictEqual(data.choices[1].index, 1);
  console.log(`  ✓ n=2, choices: "${data.choices[0].message.content}" | "${data.choices[1].message.content}"`);
});

// ── Parameter passthrough ─────────────────────────────────────────────────────

liveTest("live: temperature=0 produces deterministic output", async () => {
  const payload = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: 'Answer with exactly "pineapple".' }],
    temperature: 0,
    max_completion_tokens: 5,
  };

  const res1 = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const res2 = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const d1 = await res1.json();
  const d2 = await res2.json();
  console.log(`  ✓ temperature=0: "${d1.choices[0].message.content}" == "${d2.choices[0].message.content}"`);
  // Both should contain the same root word (lowercase compare)
  assert.strictEqual(
    d1.choices[0].message.content.toLowerCase().replace(/[^a-z]/g, ""),
    d2.choices[0].message.content.toLowerCase().replace(/[^a-z]/g, ""),
    "temperature=0 should produce identical outputs",
  );
});

liveTest("live: max_completion_tokens limits output length", async () => {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Write a 500 word essay about the ocean." }],
      max_completion_tokens: 20,
    }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  const content = data.choices[0].message.content;
  const words = content.split(/\s+/).length;
  assert.ok(words <= 30, `Expected ≤30 words for max_tokens=20, got ${words}`);
  assert.ok(["stop", "length"].includes(data.choices[0].finish_reason));
  console.log(`  ✓ max_completion_tokens=20: words=${words}, finish=${data.choices[0].finish_reason}`);
});

liveTest("live: stop sequences terminate output", async () => {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "List items: item1, item2, STOP_HERE, item3, item4" }],
      stop: ["STOP_HERE"],
      temperature: 0,
    }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  const content = data.choices[0].message.content;
  assert.ok(!content.includes("item3"), `Output should not contain text after stop sequence: "${content}"`);
  console.log(`  ✓ stop sequence: "${content.slice(0, 80)}"`);
});

// ── response_format: json_object ──────────────────────────────────────────────

liveTest("live: response_format json_object returns parseable JSON", async () => {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: 'Return a JSON object with keys "name" (string) and "score" (number).',
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_completion_tokens: 50,
    }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  const content = data.choices[0].message.content;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    assert.fail(`Expected valid JSON but got: "${content}"`);
  }
  assert.ok("name" in parsed || "score" in parsed, "JSON response should contain expected keys");
  console.log(`  ✓ response_format=json_object: ${content.slice(0, 100)}`);
});

// ── Multi-turn conversation ───────────────────────────────────────────────────

liveTest("live: multi-turn conversation maintains context", async () => {
  const firstRes = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "My favourite colour is indigo. Remember this." }],
      temperature: 0,
      max_completion_tokens: 30,
    }),
  });
  const firstData = await firstRes.json();
  assert.strictEqual(firstData.choices[0].message.role, "assistant");

  // Second turn — ask about remembered colour
  const secondRes = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "user", content: "My favourite colour is indigo. Remember this." },
        { role: "assistant", content: firstData.choices[0].message.content },
        { role: "user", content: "What is my favourite colour? Answer in one word." },
      ],
      temperature: 0,
      max_completion_tokens: 10,
    }),
  });
  const secondData = await secondRes.json();
  const answer = secondData.choices[0].message.content.toLowerCase();
  assert.ok(answer.includes("indigo"), `Expected "indigo" in multi-turn answer but got: "${answer}"`);
  console.log(`  ✓ multi-turn context: answer="${answer}"`);
});

// ── Tool calling (if supported by model) ─────────────────────────────────────

liveTest("live: tool calling with gpt-4o", async () => {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "What is the current weather in Paris?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_current_weather",
            description: "Get the current weather in a given location",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string", description: "City name, e.g. Paris" },
                unit: { type: "string", enum: ["celsius", "fahrenheit"] },
              },
              required: ["location"],
            },
          },
        },
      ],
      tool_choice: "auto",
      temperature: 0,
    }),
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();

  // Model should either call the tool or answer directly
  const choice = data.choices[0];
  if (choice.finish_reason === "tool_calls") {
    assert.ok(Array.isArray(choice.message.tool_calls));
    const tc = choice.message.tool_calls[0];
    assert.strictEqual(tc.type, "function");
    assert.strictEqual(tc.function.name, "get_current_weather");
    const args = JSON.parse(tc.function.arguments);
    assert.ok(args.location, "tool call should have a location argument");
    console.log(`  ✓ tool call: ${tc.function.name}(${tc.function.arguments})`);
  } else {
    // Acceptable: model answered without calling the tool
    console.log(`  ✓ model answered directly (no tool call): "${choice.message.content?.slice(0, 80)}"`);
  }
});

// ── Mode / Echo ───────────────────────────────────────────────────────────────

liveTest("live: GET /v1/mode returns bridge by default", async () => {
  const res = await fetch(`${BASE_URL}/v1/mode`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.mode, "bridge");
  console.log(`  ✓ /v1/mode GET returns mode=${data.mode}`);
});

liveTest("live: POST /v1/mode can switch to echo and back", async () => {
  // Switch to echo mode
  const toEcho = await fetch(`${BASE_URL}/v1/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "echo" }),
  });
  assert.strictEqual(toEcho.status, 200);
  const echoData = await toEcho.json();
  assert.strictEqual(echoData.mode, "echo");

  // Verify health also reflects echo mode
  const healthRes = await fetch(`${BASE_URL}/health`);
  const healthData = await healthRes.json();
  assert.strictEqual(healthData.mode, "echo");

  // Switch back to bridge mode
  const toBridge = await fetch(`${BASE_URL}/v1/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "bridge" }),
  });
  assert.strictEqual(toBridge.status, 200);
  const bridgeData = await toBridge.json();
  assert.strictEqual(bridgeData.mode, "bridge");

  console.log(`  ✓ mode switch: bridge → echo → bridge`);
});

liveTest("live: POST /v1/mode rejects invalid mode value", async () => {
  const res = await fetch(`${BASE_URL}/v1/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "invalid" }),
  });
  assert.strictEqual(res.status, 400);
  console.log(`  ✓ /v1/mode POST rejects invalid mode (400)`);
});

liveTest("live: echo mode returns [Echo] prefixed response", async () => {
  // Enable echo mode
  await fetch(`${BASE_URL}/v1/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "echo" }),
  });

  try {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const content = data.choices[0].message.content as string;
    assert.ok(content.startsWith("[Echo]"), `echo response should start with [Echo], got: ${content.slice(0, 60)}`);
    console.log(`  ✓ echo mode response: "${content.slice(0, 80)}"`);
  } finally {
    // Always restore bridge mode
    await fetch(`${BASE_URL}/v1/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "bridge" }),
    });
  }
});

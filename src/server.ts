import express from "express";
import { NextFunction, Request, Response } from "express";

// ============================================================
// Exported Types (OpenAI-compatible)
// ============================================================

export type ChatMessage = {
  role: string;
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: object;
    strict?: boolean;
  };
};

export type RequestOptions = {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  n?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  seed?: number;
  response_format?: { type: string };
  tools?: OpenAITool[];
  tool_choice?: string | { type: string; function?: { name: string } };
  user?: string;
};

export type UsageInfo = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type ChatResult = {
  content: string | null;
  tool_calls?: ToolCall[];
  finish_reason?: string;
  usage?: UsageInfo;
};

export type StreamChunkDelta = {
  role?: string;
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }>;
};

export type ModelInfo = {
  id: string;
  name: string;
  vendor: string;
  family?: string;
};

export type ModelProvider = () => Promise<ModelInfo[]>;

export type BridgeControl = {
  stop: () => void;
  setEchoMode: (echo: boolean) => void;
  getEchoMode: () => boolean;
};

/**
 * Full-featured chat handler. Receives the complete messages array, model id,
 * and all OpenAI-compatible options. Returns a ChatResult.
 */
export type ChatHandler = (messages: ChatMessage[], modelId: string | null, options: RequestOptions) => Promise<ChatResult>;

/**
 * Streaming chat handler. Calls onChunk for each content/tool-call delta.
 * Returns final metadata (usage, finish_reason).
 */
export type StreamChatHandler = (
  messages: ChatMessage[],
  modelId: string | null,
  options: RequestOptions,
  onChunk: (delta: StreamChunkDelta) => void,
) => Promise<{ usage?: UsageInfo; finish_reason?: string }>;

type NormalizedErrorBody = {
  message: string;
  type: string;
  code: string | null;
  param?: string | null;
};

type NormalizedError = {
  status: number;
  error: NormalizedErrorBody;
  retryAfterSeconds?: number;
};

const JSON_BODY_LIMIT = "4mb";
const MAX_N_CHOICES = 10;
const SUPPORTED_MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createErrorResponse(
  status: number,
  message: string,
  type: string,
  code: string | null,
  param?: string | null,
  retryAfterSeconds?: number,
): NormalizedError {
  const error: NormalizedErrorBody = { message, type, code };
  if (param !== undefined) {
    error.param = param;
  }
  return { status, error, retryAfterSeconds };
}

function serializeErrorResponse(normalizedError: NormalizedError): { error: NormalizedErrorBody } {
  return { error: normalizedError.error };
}

function sendErrorResponse(res: Response, normalizedError: NormalizedError): Response {
  if (normalizedError.retryAfterSeconds !== undefined) {
    res.setHeader("Retry-After", String(normalizedError.retryAfterSeconds));
  }
  return res.status(normalizedError.status).json(serializeErrorResponse(normalizedError));
}

function normalizeThrownError(err: unknown): NormalizedError {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "Unexpected server error";

  if (message.includes("Response contained no choices")) {
    return createErrorResponse(503, message, "upstream_capacity_error", "no_choices", undefined, 10);
  }

  if (message.includes("Message exceeds token limit")) {
    return createErrorResponse(400, message, "invalid_request_error", "context_length_exceeded", "messages");
  }

  // Copilot LM API throws "Response too long." when the generated output exceeds the
  // model's response-length limit. Map to 400 so clients know to reduce context or
  // expected output size. (In OpenAI this surfaces as finish_reason:"length".)
  if (message.includes("Response too long")) {
    return createErrorResponse(400, message, "invalid_request_error", "response_too_long");
  }

  if (message.includes("No matching language model found")) {
    return createErrorResponse(503, message, "upstream_unavailable_error", "no_model_available");
  }

  // Upstream returned a 4xx validation error (e.g. temperature out of range).
  // Map to 400 so callers see an invalid_request_error rather than a 500.
  const upstreamFailMatch = /^Request Failed: (4\d\d)\b/.exec(message);
  if (upstreamFailMatch) {
    return createErrorResponse(400, message, "invalid_request_error", "upstream_validation_error");
  }

  return createErrorResponse(500, message, "server_error", null);
}

function normalizeBodyParserError(err: unknown): NormalizedError | null {
  if (isRecord(err) && err.type === "entity.too.large") {
    return createErrorResponse(413, `Request body exceeds the ${JSON_BODY_LIMIT} limit`, "invalid_request_error", "request_too_large");
  }

  if (err instanceof SyntaxError && isRecord(err) && "body" in err) {
    return createErrorResponse(400, "Request body must be valid JSON", "invalid_request_error", "invalid_json");
  }

  return null;
}

function normalizeMessageContent(
  content: unknown,
  paramPath: string,
): { value?: string | null; error?: NormalizedError } {
  if (content === null) {
    return { value: null };
  }

  if (typeof content === "string") {
    return { value: content };
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];

    for (let index = 0; index < content.length; index++) {
      const part = content[index];
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") {
        return {
          error: createErrorResponse(
            400,
            "Only text content parts are supported in messages[].content arrays",
            "invalid_request_error",
            "unsupported_content_type",
            `${paramPath}[${index}]`,
          ),
        };
      }
      textParts.push(part.text);
    }

    return { value: textParts.join("\n") };
  }

  return {
    error: createErrorResponse(
      400,
      `${paramPath} must be a string, null, or an array of text parts`,
      "invalid_request_error",
      "invalid_message_content",
      paramPath,
    ),
  };
}

function normalizeToolCalls(rawToolCalls: unknown, paramPath: string): { value?: ToolCall[]; error?: NormalizedError } {
  if (rawToolCalls === undefined) {
    return {};
  }

  if (!Array.isArray(rawToolCalls)) {
    return {
      error: createErrorResponse(400, `${paramPath} must be an array`, "invalid_request_error", "invalid_tool_calls", paramPath),
    };
  }

  const toolCalls: ToolCall[] = [];
  for (let index = 0; index < rawToolCalls.length; index++) {
    const rawToolCall = rawToolCalls[index];
    if (
      !isRecord(rawToolCall) ||
      typeof rawToolCall.id !== "string" ||
      rawToolCall.type !== "function" ||
      !isRecord(rawToolCall.function) ||
      typeof rawToolCall.function.name !== "string" ||
      typeof rawToolCall.function.arguments !== "string"
    ) {
      return {
        error: createErrorResponse(
          400,
          `${paramPath}[${index}] must contain id, type="function", and function{name,arguments}`,
          "invalid_request_error",
          "invalid_tool_calls",
          `${paramPath}[${index}]`,
        ),
      };
    }

    toolCalls.push({
      id: rawToolCall.id,
      type: "function",
      function: {
        name: rawToolCall.function.name,
        arguments: rawToolCall.function.arguments,
      },
    });
  }

  return { value: toolCalls };
}

function normalizeMessages(rawMessages: unknown): { messages?: ChatMessage[]; error?: NormalizedError } {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    return {
      error: createErrorResponse(
        400,
        "messages is required and must be a non-empty array",
        "invalid_request_error",
        null,
        "messages",
      ),
    };
  }

  const messages: ChatMessage[] = [];

  for (let index = 0; index < rawMessages.length; index++) {
    const rawMessage = rawMessages[index];
    const paramPath = `messages[${index}]`;

    if (!isRecord(rawMessage)) {
      return {
        error: createErrorResponse(400, `${paramPath} must be an object`, "invalid_request_error", "invalid_message", paramPath),
      };
    }

    if (typeof rawMessage.role !== "string" || !SUPPORTED_MESSAGE_ROLES.has(rawMessage.role)) {
      return {
        error: createErrorResponse(
          400,
          `${paramPath}.role must be one of: system, user, assistant, tool`,
          "invalid_request_error",
          "invalid_message_role",
          `${paramPath}.role`,
        ),
      };
    }

    const normalizedContent = normalizeMessageContent(rawMessage.content, `${paramPath}.content`);
    if (normalizedContent.error) {
      return normalizedContent;
    }

    if ((rawMessage.role === "system" || rawMessage.role === "user" || rawMessage.role === "tool") && normalizedContent.value === null) {
      return {
        error: createErrorResponse(
          400,
          `${paramPath}.content must be a string for ${rawMessage.role} messages`,
          "invalid_request_error",
          "invalid_message_content",
          `${paramPath}.content`,
        ),
      };
    }

    const normalizedToolCalls = normalizeToolCalls(rawMessage.tool_calls, `${paramPath}.tool_calls`);
    if (normalizedToolCalls.error) {
      return normalizedToolCalls;
    }

    if (rawMessage.role === "tool" && typeof rawMessage.tool_call_id !== "string") {
      return {
        error: createErrorResponse(
          400,
          `${paramPath}.tool_call_id is required for tool messages`,
          "invalid_request_error",
          "invalid_tool_call_id",
          `${paramPath}.tool_call_id`,
        ),
      };
    }

    const message: ChatMessage = {
      role: rawMessage.role,
      content: normalizedContent.value ?? null,
    };

    if (typeof rawMessage.name === "string") {
      message.name = rawMessage.name;
    }
    if (typeof rawMessage.tool_call_id === "string") {
      message.tool_call_id = rawMessage.tool_call_id;
    }
    if (normalizedToolCalls.value && normalizedToolCalls.value.length > 0) {
      message.tool_calls = normalizedToolCalls.value;
    }

    messages.push(message);
  }

  return { messages };
}

function validateRequestOptions(options: RequestOptions): NormalizedError | null {
  if (options.n !== undefined && (!Number.isInteger(options.n) || options.n < 1)) {
    return createErrorResponse(400, "n must be a positive integer", "invalid_request_error", "invalid_n", "n");
  }

  if ((options.n ?? 1) > 1 && options.stream) {
    return createErrorResponse(
      400,
      "Streaming requests currently support only n=1",
      "invalid_request_error",
      "unsupported_stream_n",
      "n",
    );
  }

  // temperature must be in [0, 2] — matches the OpenAI spec and the GitHub Copilot LM API limit.
  // Validate here so callers get a clean 400 rather than a VS Code LM API error.
  if (options.temperature !== undefined) {
    if (typeof options.temperature !== "number" || isNaN(options.temperature)) {
      return createErrorResponse(400, "temperature must be a number", "invalid_request_error", "invalid_temperature", "temperature");
    }
    if (options.temperature < 0 || options.temperature > 2) {
      return createErrorResponse(
        400,
        `Invalid 'temperature': decimal above maximum value. Expected a value <= 2, but got ${options.temperature} instead.`,
        "invalid_request_error",
        "invalid_temperature",
        "temperature",
      );
    }
  }

  // top_p must be in [0, 1]
  if (options.top_p !== undefined) {
    if (typeof options.top_p !== "number" || isNaN(options.top_p) || options.top_p < 0 || options.top_p > 1) {
      return createErrorResponse(
        400,
        "Invalid 'top_p': must be a number in the range [0, 1].",
        "invalid_request_error",
        "invalid_top_p",
        "top_p",
      );
    }
  }

  if (
    options.response_format !== undefined &&
    (!isRecord(options.response_format) || options.response_format.type !== "json_object")
  ) {
    return createErrorResponse(
      400,
      'Only response_format.type="json_object" is supported',
      "invalid_request_error",
      "unsupported_response_format",
      "response_format",
    );
  }

  if (
    options.stop !== undefined &&
    !(typeof options.stop === "string" || (Array.isArray(options.stop) && options.stop.every((value) => typeof value === "string")))
  ) {
    return createErrorResponse(400, "stop must be a string or an array of strings", "invalid_request_error", "invalid_stop", "stop");
  }

  return null;
}

export async function startBridge(
  port: number,
  modelProvider?: ModelProvider,
  chatHandler?: ChatHandler,
  streamChatHandler?: StreamChatHandler,
  version?: string,
): Promise<BridgeControl> {
  const app = express();
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  let echoMode = false;
  let cachedModels: ModelInfo[] = [];

  // Health check endpoint (for monitoring)
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", port, version: version || "unknown", mode: echoMode ? "echo" : "bridge" });
  });

  // OpenAI API compatible endpoint: GET /v1/models
  app.get("/v1/models", async (_req: Request, res: Response) => {
    const fallbackModels: ModelInfo[] = [{ id: "default", name: "VSCode Copilot Default", vendor: "copilot" }];

    // In echo mode, serve the last cached models (or fallback if cache is empty)
    if (echoMode) {
      const models = cachedModels.length > 0 ? cachedModels : fallbackModels;
      return res.json({
        object: "list",
        data: models.map((m) => ({
          id: m.id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: m.vendor || "copilot",
        })),
      });
    }

    let models: ModelInfo[] = fallbackModels;
    if (modelProvider) {
      try {
        const providedModels = await modelProvider();
        if (providedModels && providedModels.length > 0) {
          models = providedModels;
          cachedModels = models; // keep cache up to date
        }
      } catch (err: any) {
        console.error("Error fetching models from provider:", err.message);
      }
    }

    // Transform to OpenAI API format
    const openaiModels = models.map((m) => ({
      id: m.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: m.vendor || "copilot",
    }));

    res.json({
      object: "list",
      data: openaiModels,
    });
  });

  // Mode control: GET /v1/mode
  app.get("/v1/mode", (_req: Request, res: Response) => {
    res.json({ mode: echoMode ? "echo" : "bridge" });
  });

  // Mode control: POST /v1/mode  — body: { "mode": "echo" | "bridge" }
  app.post("/v1/mode", (req: Request, res: Response) => {
    const { mode } = req.body || {};
    if (mode !== "echo" && mode !== "bridge") {
      return res.status(400).json({
        error: { message: 'mode must be "echo" or "bridge"', type: "invalid_request_error", code: null },
      });
    }
    echoMode = mode === "echo";
    res.json({ mode: echoMode ? "echo" : "bridge" });
  });

  // OpenAI API compatible endpoint: POST /v1/chat/completions
  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    const body = req.body || {};
    const {
      messages,
      model,
      stream,
      // All OpenAI-compatible parameters passed through to the handler
      temperature,
      top_p,
      max_tokens,
      max_completion_tokens,
      n,
      stream_options,
      stop,
      presence_penalty,
      frequency_penalty,
      logit_bias,
      seed,
      response_format,
      tools,
      tool_choice,
      user,
    } = body;

    const normalizedMessages = normalizeMessages(messages);
    if (normalizedMessages.error) {
      return sendErrorResponse(res, normalizedMessages.error);
    }

    const modelId: string | null = typeof model === "string" && model.trim() ? model : null;

    // Build RequestOptions with all extracted parameters
    const requestOptions: RequestOptions = {
      temperature,
      top_p,
      max_tokens,
      max_completion_tokens,
      n,
      stream: !!stream,
      stream_options,
      stop,
      presence_penalty,
      frequency_penalty,
      logit_bias,
      seed,
      response_format,
      tools,
      tool_choice,
      user,
    };

    const requestValidationError = validateRequestOptions(requestOptions);
    if (requestValidationError) {
      return sendErrorResponse(res, requestValidationError);
    }

    const chatId = `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    const created = Math.floor(Date.now() / 1000);
    const normalizedRequestMessages = normalizedMessages.messages ?? [];
    const numChoices = typeof n === "number" && n >= 1 ? Math.min(n, MAX_N_CHOICES) : 1;

    // ---- ECHO MODE ----
    if (echoMode) {
      const lastUserMsg = normalizedRequestMessages.filter((m) => m.role === "user").pop();
      const echoContent = `[Echo] ${lastUserMsg?.content ?? "(no user message)"}`;

      if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        const writeEchoSSE = (choices: object[], usageData?: UsageInfo) => {
          const chunk: Record<string, unknown> = {
            id: chatId,
            object: "chat.completion.chunk",
            created,
            model: modelId || "default",
            choices,
          };
          if (usageData) chunk.usage = usageData;
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        };
        writeEchoSSE([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
        writeEchoSSE([{ index: 0, delta: { content: echoContent }, finish_reason: null }]);
        writeEchoSSE([{ index: 0, delta: {}, finish_reason: "stop" }]);
        if (stream_options?.include_usage) {
          writeEchoSSE([], { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
        }
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        const echoChoices = Array.from({ length: numChoices }, (_, i) => ({
          index: i,
          message: { role: "assistant", content: echoContent },
          finish_reason: "stop",
        }));
        res.json({
          id: chatId,
          object: "chat.completion",
          created,
          model: modelId || "default",
          choices: echoChoices,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
      return;
    }

    // ---- STREAMING ----
    if (stream) {
      let streamStarted = false;

      const writeSSE = (choices: object[], usageData?: UsageInfo) => {
        const chunk: Record<string, unknown> = {
          id: chatId,
          object: "chat.completion.chunk",
          created,
          model: modelId || "default",
          choices,
        };
        if (usageData) {
          chunk.usage = usageData;
        }
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      };

      const ensureStreamStarted = () => {
        if (streamStarted) {
          return;
        }

        streamStarted = true;
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        writeSSE([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
      };

      if (streamChatHandler) {
        try {
          const streamResult = await streamChatHandler(normalizedRequestMessages, modelId, requestOptions, (delta: StreamChunkDelta) => {
            ensureStreamStarted();
            writeSSE([{ index: 0, delta, finish_reason: null }]);
          });

          ensureStreamStarted();
          const finishReason = streamResult?.finish_reason || "stop";
          writeSSE([{ index: 0, delta: {}, finish_reason: finishReason }]);

          // If stream_options.include_usage, send usage chunk before [DONE]
          if (stream_options?.include_usage && streamResult?.usage) {
            writeSSE([], streamResult.usage);
          }

          res.write("data: [DONE]\n\n");
          res.end();
        } catch (err: any) {
          const normalizedError = normalizeThrownError(err);
          if (!streamStarted) {
            return sendErrorResponse(res, normalizedError);
          }

          res.write(`data: ${JSON.stringify(serializeErrorResponse(normalizedError))}\n\n`);
          res.end();
        }
      } else {
        // Fallback simulated streaming (no real handler registered)
        const lastUserMsg = normalizedRequestMessages.filter((m) => m.role === "user").pop();
        const lines = [`Echo (stream): ${lastUserMsg?.content || "(no user message)"}`];

        ensureStreamStarted();
        for (const line of lines) {
          writeSSE([{ index: 0, delta: { content: line }, finish_reason: null }]);
          await new Promise((r) => setTimeout(r, 50));
        }
        writeSSE([{ index: 0, delta: {}, finish_reason: "stop" }]);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      return;
    }

    // ---- NON-STREAMING ----
    if (chatHandler) {
      try {
        const choices: object[] = [];
        let aggregatedUsage: UsageInfo = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

        for (let i = 0; i < numChoices; i++) {
          const result = await chatHandler(normalizedRequestMessages, modelId, requestOptions);

          const choice: Record<string, unknown> = {
            index: i,
            message: {
              role: "assistant",
              content: result.content,
            },
            finish_reason: result.finish_reason || "stop",
          };

          if (result.tool_calls && result.tool_calls.length > 0) {
            (choice.message as Record<string, unknown>).tool_calls = result.tool_calls;
            choice.finish_reason = "tool_calls";
          }

          choices.push(choice);

          if (result.usage) {
            aggregatedUsage.prompt_tokens += result.usage.prompt_tokens;
            aggregatedUsage.completion_tokens += result.usage.completion_tokens;
            aggregatedUsage.total_tokens += result.usage.total_tokens;
          }
        }

        res.json({
          id: chatId,
          object: "chat.completion",
          created,
          model: modelId || "default",
          choices,
          usage: aggregatedUsage,
        });
      } catch (err: any) {
        console.error("Chat handler error:", err.message);
        return sendErrorResponse(res, normalizeThrownError(err));
      }
    } else {
      // Fallback echo response (no handler registered)
      const lastUserMsg = normalizedRequestMessages.filter((m) => m.role === "user").pop();
      const echoContent = `Echo: ${lastUserMsg?.content || "(no user message)"}`;
      const choices = Array.from({ length: numChoices }, (_, i) => ({
        index: i,
        message: { role: "assistant", content: echoContent },
        finish_reason: "stop",
      }));

      res.json({
        id: chatId,
        object: "chat.completion",
        created,
        model: modelId || "default",
        choices,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const normalizedError = normalizeBodyParserError(err) ?? normalizeThrownError(err);
    if (!res.headersSent) {
      sendErrorResponse(res, normalizedError);
    }
  });

  const server = app.listen(port, "127.0.0.1");
  console.log(`Copilot Connect server started at http://127.0.0.1:${port}`);

  // Prime the model cache at startup (best-effort, non-blocking)
  if (modelProvider) {
    modelProvider()
      .then((models) => {
        if (models.length > 0) cachedModels = models;
      })
      .catch(() => {});
  }

  return {
    stop: () => {
      server.close();
      console.log("Copilot Connect server stopped");
    },
    setEchoMode: (echo: boolean) => {
      echoMode = echo;
    },
    getEchoMode: () => echoMode,
  };
}

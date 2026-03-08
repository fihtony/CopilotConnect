import express from "express";
import { Request, Response } from "express";

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

export async function startBridge(
  port: number,
  modelProvider?: ModelProvider,
  chatHandler?: ChatHandler,
  streamChatHandler?: StreamChatHandler,
  version?: string,
): Promise<BridgeControl> {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

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

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: "messages is required and must be a non-empty array",
          type: "invalid_request_error",
          param: "messages",
          code: null,
        },
      });
    }

    const modelId: string | null = model || null;

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

    const chatId = `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    const created = Math.floor(Date.now() / 1000);

    // ---- ECHO MODE ----
    if (echoMode) {
      const lastUserMsg = (messages as ChatMessage[]).filter((m) => m.role === "user").pop();
      const echoContent = `[Echo] ${lastUserMsg?.content ?? "(no user message)"}`;
      const numEchoChoices = typeof n === "number" && n >= 1 ? Math.min(n, 10) : 1;

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
        const echoChoices = Array.from({ length: numEchoChoices }, (_, i) => ({
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
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

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

      if (streamChatHandler) {
        try {
          // Emit role-only opening chunk (OpenAI convention)
          writeSSE([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);

          const streamResult = await streamChatHandler(messages as ChatMessage[], modelId, requestOptions, (delta: StreamChunkDelta) => {
            writeSSE([{ index: 0, delta, finish_reason: null }]);
          });

          const finishReason = streamResult?.finish_reason || "stop";
          writeSSE([{ index: 0, delta: {}, finish_reason: finishReason }]);

          // If stream_options.include_usage, send usage chunk before [DONE]
          if (stream_options?.include_usage && streamResult?.usage) {
            writeSSE([], streamResult.usage);
          }

          res.write("data: [DONE]\n\n");
          res.end();
        } catch (err: any) {
          res.write(`data: ${JSON.stringify({ error: { message: err.message, type: "server_error", code: null } })}\n\n`);
          res.end();
        }
      } else {
        // Fallback simulated streaming (no real handler registered)
        const lastUserMsg = (messages as ChatMessage[]).filter((m) => m.role === "user").pop();
        const lines = [`Echo (stream): ${lastUserMsg?.content || "(no user message)"}`];

        writeSSE([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]);
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
    const numChoices = typeof n === "number" && n >= 1 ? Math.min(n, 10) : 1;

    if (chatHandler) {
      try {
        const choices: object[] = [];
        let aggregatedUsage: UsageInfo = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

        for (let i = 0; i < numChoices; i++) {
          const result = await chatHandler(messages as ChatMessage[], modelId, requestOptions);

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
        return res.status(500).json({
          error: {
            message: err.message,
            type: "server_error",
            code: null,
          },
        });
      }
    } else {
      // Fallback echo response (no handler registered)
      const lastUserMsg = (messages as ChatMessage[]).filter((m) => m.role === "user").pop();
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

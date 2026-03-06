import express from "express";
import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";

type Session = {
  id: string;
  createdAt: string; // ISO 8601 format
  lastUsed: string; // ISO 8601 format
  messages: Array<{ role: string; content: string }>;
  modelId?: string | null;
  fallbackEnabled: boolean; // Session-specific fallback mode setting
};

type ModelInfo = {
  id: string;
  name: string;
  vendor: string;
  family?: string;
};

type ModelProvider = () => Promise<ModelInfo[]>;
type ChatHandler = (prompt: string, context: string | null, modelId: string | null) => Promise<string>;
type StreamChatHandler = (
  prompt: string,
  context: string | null,
  modelId: string | null,
  onChunk: (chunk: string) => void
) => Promise<void>;

const sessions: Map<string, Session> = new Map();

export async function startBridge(
  port: number,
  modelProvider?: ModelProvider,
  chatHandler?: ChatHandler,
  streamChatHandler?: StreamChatHandler,
  version?: string
): Promise<() => void> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", port, version: version || "unknown" });
  });

  app.get("/models", async (_req: Request, res: Response) => {
    // Use the modelProvider if available, otherwise return fallback
    const fallbackModels: ModelInfo[] = [{ id: "default", name: "VSCode Copilot Default", vendor: "copilot" }];

    if (modelProvider) {
      try {
        const models = await modelProvider();
        if (models && models.length > 0) {
          return res.json({ success: true, models });
        }
        console.warn("Model provider returned empty models; using fallback");
      } catch (err: any) {
        console.error("Error fetching models from provider:", err.message);
      }
    }

    res.json({ success: true, models: fallbackModels });
  });

  // OpenAI API compatible endpoint: GET /v1/models
  app.get("/v1/models", async (_req: Request, res: Response) => {
    const fallbackModels: ModelInfo[] = [{ id: "default", name: "VSCode Copilot Default", vendor: "copilot" }];

    let models: ModelInfo[] = fallbackModels;
    if (modelProvider) {
      try {
        const providedModels = await modelProvider();
        if (providedModels && providedModels.length > 0) {
          models = providedModels;
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

  app.post("/session/create", (_req: Request, res: Response) => {
    const id = uuidv4();
    const now = new Date().toISOString();
    const s: Session = { id, createdAt: now, lastUsed: now, messages: [], modelId: null, fallbackEnabled: true };
    sessions.set(id, s);
    res.json({ success: true, sessionId: id });
  });

  app.get("/session/:id", (req: Request, res: Response) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ success: false, error: "Session not found" });
    res.json({
      success: true,
      session: {
        id: s.id,
        createdAt: s.createdAt,
        lastUsed: s.lastUsed,
        messageCount: s.messages.length,
        modelId: s.modelId,
        fallbackEnabled: s.fallbackEnabled,
      },
    });
  });

  app.post("/session/:id/clear", (req: Request, res: Response) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ success: false, error: "Session not found" });
    s.messages = [];
    s.lastUsed = new Date().toISOString();
    res.json({ success: true, message: "Session cleared" });
  });

  app.delete("/session/:id", (req: Request, res: Response) => {
    const ok = sessions.delete(req.params.id);
    if (!ok) return res.status(404).json({ success: false, error: "Session not found" });
    res.json({ success: true, message: "Session deleted" });
  });

  // Session-specific fallback mode management
  app.get("/session/:id/fallback/status", (req: Request, res: Response) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ success: false, error: "Session not found" });
    res.json({ success: true, fallbackEnabled: s.fallbackEnabled });
  });

  app.post("/session/:id/fallback/toggle", (req: Request, res: Response) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ success: false, error: "Session not found" });
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ success: false, error: "enabled must be a boolean" });
    }
    s.fallbackEnabled = enabled;
    s.lastUsed = new Date().toISOString();
    res.json({ success: true, fallbackEnabled: s.fallbackEnabled });
  });

  // Deprecated global fallback endpoints (for backward compatibility)
  app.get("/fallback/status", (_req: Request, res: Response) => {
    res.json({
      success: true,
      fallbackEnabled: true,
      deprecated: true,
      message: "Use session-specific endpoint /session/:id/fallback/status instead",
    });
  });

  app.post("/fallback/toggle", (_req: Request, res: Response) => {
    res.json({ success: false, deprecated: true, message: "Use session-specific endpoint /session/:id/fallback/toggle instead" });
  });

  // Non-streaming chat
  app.post("/chat", async (req: Request, res: Response) => {
    const { prompt, context, timeout, model_id, model_name, newSession, sessionId } = req.body || {};

    // session handling
    let targetSessionId = sessionId;
    if (newSession || !targetSessionId) {
      const id = uuidv4();
      const now = new Date().toISOString();
      sessions.set(id, { id, createdAt: now, lastUsed: now, messages: [], modelId: model_id, fallbackEnabled: true });
      targetSessionId = id;
    }

    const s = sessions.get(targetSessionId);
    if (s) {
      s.messages.push({ role: "user", content: prompt });
      s.lastUsed = new Date().toISOString();
      if (model_id) {
        s.modelId = model_id;
      }
    }

    // Use chatHandler if provided, otherwise return simulated response
    let response: string;
    if (chatHandler) {
      try {
        response = await chatHandler(prompt, context || null, model_id || null);
      } catch (err: any) {
        console.error("Chat handler error:", err.message);
        return res.status(500).json({ success: false, error: err.message });
      }
    } else {
      response = `Echo: ${prompt}`;
    }

    res.json({ success: true, response, sessionId: targetSessionId });
  });

  // Streaming chat using SSE
  app.post("/chat/stream", async (req: Request, res: Response) => {
    const { prompt, context, timeout, model_id, model_name, newSession, sessionId } = req.body || {};

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // For demo: create a session id
    const id = uuidv4();
    const now = new Date().toISOString();
    sessions.set(id, {
      id,
      createdAt: now,
      lastUsed: now,
      messages: [{ role: "user", content: prompt }],
      modelId: model_id,
      fallbackEnabled: true,
    });

    // Send session id
    res.write(`data: ${JSON.stringify({ type: "session", sessionId: id })}\n\n`);

    if (streamChatHandler) {
      try {
        await streamChatHandler(prompt, context || null, model_id || null, (chunk: string) => {
          res.write(`data: ${JSON.stringify({ type: "chunk", content: chunk })}\n\n`);
        });
        res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        res.end();
      } catch (err: any) {
        res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
        res.end();
      }
    } else {
      // Fallback to simulated streaming
      const chunks = [`Processing: ${prompt}\n`, "Step 1... ", "Step 2... ", "Done."];
      let i = 0;

      const iv = setInterval(() => {
        if (i < chunks.length) {
          res.write(`data: ${JSON.stringify({ type: "chunk", content: chunks[i] })}\n\n`);
          i++;
        } else {
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          clearInterval(iv);
          res.end();
        }
      }, 300);
    }
  });

  // session-specific streaming endpoint
  app.post("/session/:id/chat/stream", (req: Request, res: Response) => {
    const { prompt } = req.body || {};
    const sid = req.params.id;
    if (!sessions.has(sid)) return res.status(404).json({ success: false, error: "Session not found" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Simulated stream
    res.write(`data: ${JSON.stringify({ type: "session", sessionId: sid })}\n\n`);
    const parts = ["Working on it...", "\n", "Almost done...", "\n", "Finished."];
    let idx = 0;
    const iv = setInterval(() => {
      if (idx < parts.length) {
        res.write(`data: ${JSON.stringify({ type: "chunk", content: parts[idx] })}\n\n`);
        idx++;
      } else {
        res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        clearInterval(iv);
        res.end();
      }
    }, 250);
  });

  // OpenAI API compatible endpoint: POST /v1/chat/completions
  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    const { messages, model, stream, temperature, max_tokens, top_p, frequency_penalty, presence_penalty, stop, n } = req.body || {};

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

    // Build prompt from messages
    let prompt = "";
    let context = "";
    for (const msg of messages) {
      if (msg.role === "system") {
        context += msg.content + "\n";
      } else if (msg.role === "user") {
        prompt = msg.content;
      } else if (msg.role === "assistant") {
        context += `Assistant: ${msg.content}\n`;
      }
    }

    const modelId = model || null;

    // Handle streaming
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const chatId = `chatcmpl-${uuidv4()}`;
      const created = Math.floor(Date.now() / 1000);

      if (streamChatHandler) {
        try {
          let isFirst = true;
          await streamChatHandler(prompt, context || null, modelId, (chunk: string) => {
            const delta: any = { content: chunk };
            if (isFirst) {
              delta.role = "assistant";
              isFirst = false;
            }

            const streamChunk = {
              id: chatId,
              object: "chat.completion.chunk",
              created,
              model: modelId || "default",
              choices: [
                {
                  index: 0,
                  delta,
                  finish_reason: null,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(streamChunk)}\n\n`);
          });

          // Send final chunk
          const finalChunk = {
            id: chatId,
            object: "chat.completion.chunk",
            created,
            model: modelId || "default",
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          };
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } catch (err: any) {
          const errorChunk = {
            error: {
              message: err.message,
              type: "server_error",
              code: null,
            },
          };
          res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
          res.end();
        }
      } else {
        // Fallback simulated streaming
        const chunks = [`Processing: ${prompt}\n`, "Step 1... ", "Step 2... ", "Done."];
        let i = 0;
        let isFirst = true;

        const iv = setInterval(() => {
          if (i < chunks.length) {
            const delta: any = { content: chunks[i] };
            if (isFirst) {
              delta.role = "assistant";
              isFirst = false;
            }

            const streamChunk = {
              id: chatId,
              object: "chat.completion.chunk",
              created,
              model: modelId || "default",
              choices: [
                {
                  index: 0,
                  delta,
                  finish_reason: null,
                },
              ],
            };
            res.write(`data: ${JSON.stringify(streamChunk)}\n\n`);
            i++;
          } else {
            const finalChunk = {
              id: chatId,
              object: "chat.completion.chunk",
              created,
              model: modelId || "default",
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                },
              ],
            };
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            res.write("data: [DONE]\n\n");
            clearInterval(iv);
            res.end();
          }
        }, 300);
      }
    } else {
      // Non-streaming response
      let responseText: string;
      if (chatHandler) {
        try {
          responseText = await chatHandler(prompt, context || null, modelId);
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
        responseText = `Echo: ${prompt}`;
      }

      const chatId = `chatcmpl-${uuidv4()}`;
      const created = Math.floor(Date.now() / 1000);

      res.json({
        id: chatId,
        object: "chat.completion",
        created,
        model: modelId || "default",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: responseText,
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      });
    }
  });

  const server = app.listen(port, "127.0.0.1");

  console.log(`Copilot Connect server started at http://127.0.0.1:${port}`);

  return async () => {
    server.close();
    console.log("Copilot Connect server stopped");
  };
}

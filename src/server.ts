import express from "express";
import { Request, Response } from "express";

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

export async function startBridge(
  port: number,
  modelProvider?: ModelProvider,
  chatHandler?: ChatHandler,
  streamChatHandler?: StreamChatHandler,
  version?: string
): Promise<() => void> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Health check endpoint (for monitoring)
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", port, version: version || "unknown" });
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

      const chatId = `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
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

      const chatId = `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
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

import * as vscode from "vscode";
import { startBridge, BridgeControl, ChatMessage, ChatResult, RequestOptions, StreamChunkDelta, UsageInfo } from "./server";

// Read version from package.json
const packageJson = require("../package.json");
const VERSION = packageJson.version;

let serverDisposable: vscode.Disposable | undefined;
let statusBarItem: vscode.StatusBarItem;
let isRunning = false;
let currentPort = 1288;
let echoMode = false;
let bridgeControl: BridgeControl | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log("[CopilotConnect] Activating...");

  const config = vscode.workspace.getConfiguration("copilotConnect");
  currentPort = config.get<number>("port", 1288);

  // Create status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "copilotConnect.toggleMenu";
  context.subscriptions.push(statusBarItem);
  updateStatusBar();

  // Register commands
  context.subscriptions.push(vscode.commands.registerCommand("copilotConnect.toggleMenu", () => showMenu(context)));

  context.subscriptions.push(vscode.commands.registerCommand("copilotConnect.start", () => startServer(context)));

  context.subscriptions.push(vscode.commands.registerCommand("copilotConnect.stop", () => stopServer()));

  context.subscriptions.push(vscode.commands.registerCommand("copilotConnect.changePort", () => changePort(context)));

  context.subscriptions.push(vscode.commands.registerCommand("copilotConnect.selectDefaultModel", () => selectDefaultModel()));

  context.subscriptions.push(vscode.commands.registerCommand("copilotConnect.setAdditionalContext", () => setAdditionalContext()));

  context.subscriptions.push(vscode.commands.registerCommand("copilotConnect.changeLanguage", () => changeLanguage()));

  context.subscriptions.push(vscode.commands.registerCommand("copilotConnect.toggleEchoMode", () => toggleEchoMode()));

  // Auto-start the bridge
  startServer(context);
}

function updateStatusBar() {
  const config = vscode.workspace.getConfiguration("copilotConnect");
  const language = config.get<string>("language", "en");

  const text = language === "zh" ? `Copilot信使` : `Copilot Connect`;
  if (isRunning) {
    if (echoMode) {
      statusBarItem.text = `$(record) ${text} Echo: ${currentPort}`;
      statusBarItem.tooltip =
        language === "zh" ? "Echo模式已激活（不发送真实请求）- 点击打开菜单" : "Echo mode active (no real requests) — Click to open menu";
      statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      statusBarItem.color = undefined;
    } else {
      statusBarItem.text = `$(radio-tower) ${text}: ${currentPort}`;
      statusBarItem.tooltip = language === "zh" ? "桥接模式 - 点击打开Copilot信使菜单" : "Bridge mode — Click to open Copilot Connect menu";
      statusBarItem.backgroundColor = undefined;
      statusBarItem.color = undefined;
    }
  } else {
    statusBarItem.text = `$(circle-slash) ${text}: ${language === "zh" ? "已停止" : "Stopped"}`;
    statusBarItem.tooltip = language === "zh" ? "点击打开Copilot信使菜单" : "Click to open Copilot Connect menu";
    statusBarItem.backgroundColor = undefined;
    statusBarItem.color = new vscode.ThemeColor("statusBar.foreground");
  }
  statusBarItem.show();
}

async function showMenu(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("copilotConnect");
  const language = config.get<string>("language", "en");
  const defaultModel = config.get<string>("defaultModel", "");

  const zh = language === "zh";

  // Get current model name if set
  let modelDisplay = zh ? "自动选择" : "Auto-select";
  if (defaultModel) {
    try {
      const models = await vscode.lm.selectChatModels({ id: defaultModel });
      if (models.length > 0) {
        modelDisplay = models[0].name || defaultModel;
      } else {
        modelDisplay = defaultModel;
      }
    } catch {
      modelDisplay = defaultModel;
    }
  }

  const items: vscode.QuickPickItem[] = [
    {
      label: zh ? `版本: ${VERSION}` : `Version: ${VERSION}`,
      description: zh
        ? `端口: ${currentPort} | 状态: ${isRunning ? "运行中" : "已停止"}`
        : `Port: ${currentPort} | Status: ${isRunning ? "Running" : "Stopped"}`,
      kind: vscode.QuickPickItemKind.Separator,
    },
    {
      label: isRunning
        ? zh
          ? "$(debug-stop) 停止信使服务"
          : "$(debug-stop) Stop Copilot Connect"
        : zh
          ? "$(debug-start) 启动信使服务"
          : "$(debug-start) Start Copilot Connect",
      description: isRunning ? (zh ? "停止信使服务" : "Stop Copilot Connect") : zh ? "启动信使服务" : "Start Copilot Connect",
    },
    {
      label: zh ? "$(settings-gear) 更改端口" : "$(settings-gear) Change Port",
      description: `${zh ? "当前端口" : "Current port"}: ${currentPort} (${zh ? "需要重启" : "requires restart"})`,
    },
    {
      label: zh ? "$(symbol-namespace) 选择默认模型" : "$(symbol-namespace) Select Default Model",
      description: `${zh ? "当前" : "Current"}: ${modelDisplay}`,
    },
    {
      label: zh ? "$(note) 设置附加上下文" : "$(note) Set Additional Context",
      description: zh ? "为所有请求添加上下文" : "Add context to all requests",
    },
    {
      label: zh ? "$(globe) 更改语言" : "$(globe) Change Language",
      description: `${zh ? "当前" : "Current"}: ${zh ? "中文" : "English"}`,
    },
    {
      label: echoMode
        ? zh
          ? "$(radio-tower) 切换到桥接模式"
          : "$(radio-tower) Switch to Bridge Mode"
        : zh
          ? "$(record) 切换到Echo模式"
          : "$(record) Switch to Echo Mode",
      description: echoMode
        ? zh
          ? "停止Echo，连接真实Copilot"
          : "Stop echoing, connect to real Copilot"
        : zh
          ? "启用Echo模式（不发送真实请求）"
          : "Enable echo mode (no real requests sent)",
    },
  ];

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: zh ? "Copilot信使设置" : "Copilot Connect Settings",
  });

  if (!selected) {
    return;
  }

  // Ignore separator item (version info)
  if (selected.label.includes("Version") || selected.label.includes("版本")) {
    return;
  }

  if (selected.label.includes("Stop") || selected.label.includes("停止")) {
    stopServer();
  } else if (selected.label.includes("Start") || selected.label.includes("启动")) {
    startServer(context);
  } else if (selected.label.includes("Port") || selected.label.includes("端口")) {
    changePort(context);
  } else if (selected.label.includes("Model") || selected.label.includes("模型")) {
    selectDefaultModel();
  } else if (selected.label.includes("Context") || selected.label.includes("上下文")) {
    setAdditionalContext();
  } else if (selected.label.includes("Language") || selected.label.includes("语言")) {
    changeLanguage();
  } else if (
    selected.label.includes("Echo") ||
    selected.label.includes("Bridge Mode") ||
    selected.label.includes("桥接模式") ||
    selected.label.includes("Echo模式")
  ) {
    toggleEchoMode();
  }
}

async function startServer(context: vscode.ExtensionContext) {
  if (isRunning) {
    vscode.window.showInformationMessage("Bridge is already running");
    return;
  }

  const config = vscode.workspace.getConfiguration("copilotConnect");
  const defaultModel = config.get<string>("defaultModel", "");
  const additionalContext = config.get<string>("additionalContext", "");

  // Model provider using VS Code Language Model API
  const modelProvider = async () => {
    try {
      const models = await vscode.lm.selectChatModels();
      return models.map((m) => ({
        id: m.id,
        name: m.name,
        vendor: m.vendor,
        family: m.family,
      }));
    } catch (err: any) {
      console.error("[CopilotConnect] Failed to fetch models:", err);
      return [];
    }
  };

  /**
   * Resolve the best VS Code LanguageModelChat for the given model id.
   * Falls back to any copilot model if the exact id is not found.
   */
  async function resolveModel(modelId: string | null): Promise<vscode.LanguageModelChat> {
    const effectiveId = modelId || defaultModel || null;
    const selector = effectiveId ? { id: effectiveId } : { vendor: "copilot" };
    let models = await vscode.lm.selectChatModels(selector);

    if (models.length === 0 && effectiveId) {
      console.warn(`[CopilotConnect] No model found for "${effectiveId}", falling back to copilot default`);
      models = await vscode.lm.selectChatModels({ vendor: "copilot" });
    }
    if (models.length === 0) {
      throw new Error("No matching language model found. Make sure GitHub Copilot is installed and signed in.");
    }

    const exactMatch = effectiveId ? models.find((m) => m.id === effectiveId) : undefined;
    const selected = exactMatch ?? models[0];
    console.log(`[CopilotConnect] Model selected: ${selected.id} (${selected.name})`);
    return selected;
  }

  /**
   * Convert OpenAI-format ChatMessage[] to vscode.LanguageModelChatMessage[].
   * - System messages are prepended to the next user message.
   * - Tool messages (role="tool") become User messages with a ToolResultPart.
   * - Assistant messages with tool_calls use LanguageModelToolCallPart.
   * - If response_format is json_object, a JSON instruction is prepended.
   */
  function convertMessages(
    messages: ChatMessage[],
    extraContext: string | undefined,
    responseFormat?: { type: string },
  ): vscode.LanguageModelChatMessage[] {
    const result: vscode.LanguageModelChatMessage[] = [];
    const pendingSystem: string[] = [];

    if (extraContext) pendingSystem.push(extraContext);
    if (responseFormat?.type === "json_object") {
      pendingSystem.push("You must respond with valid JSON only. Do not include any prose or markdown fences.");
    }

    for (const msg of messages) {
      if (msg.role === "system") {
        pendingSystem.push(msg.content ?? "");
        continue;
      }

      if (msg.role === "user") {
        let text = msg.content ?? "";
        if (pendingSystem.length > 0) {
          text = pendingSystem.join("\n\n") + "\n\n" + text;
          pendingSystem.length = 0;
        }
        result.push(vscode.LanguageModelChatMessage.User(text));
        continue;
      }

      if (msg.role === "assistant") {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
          if (msg.content) {
            parts.push(new vscode.LanguageModelTextPart(msg.content));
          }
          for (const tc of msg.tool_calls) {
            let input: object = {};
            try {
              input = JSON.parse(tc.function.arguments);
            } catch {
              // leave as empty object
            }
            parts.push(new vscode.LanguageModelToolCallPart(tc.id, tc.function.name, input));
          }
          result.push(vscode.LanguageModelChatMessage.Assistant(parts));
        } else {
          result.push(vscode.LanguageModelChatMessage.Assistant(msg.content ?? ""));
        }
        continue;
      }

      if (msg.role === "tool") {
        // Tool result must be wrapped in a User message
        const toolResultPart = new vscode.LanguageModelToolResultPart(msg.tool_call_id ?? "", [
          new vscode.LanguageModelTextPart(msg.content ?? ""),
        ]);
        result.push(vscode.LanguageModelChatMessage.User([toolResultPart]));
        continue;
      }
    }

    if (pendingSystem.length > 0) {
      result.unshift(vscode.LanguageModelChatMessage.User(pendingSystem.join("\n\n")));
    }

    return result;
  }

  function normalizeJsonObjectContent(content: string | null, responseFormat?: { type: string }): string | null {
    if (responseFormat?.type !== "json_object" || content == null) {
      return content;
    }

    const trimmed = content.trim();
    const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const candidate = (fencedMatch?.[1] ?? trimmed).trim();

    try {
      return JSON.stringify(JSON.parse(candidate));
    } catch {
      return content;
    }
  }

  /**
   * Build VS Code LanguageModelChatRequestOptions from OpenAI RequestOptions.
   */
  function buildVsCodeOptions(opts: RequestOptions): vscode.LanguageModelChatRequestOptions {
    // Convert OpenAI tools to VS Code LanguageModelChatTool format
    let vsCodeTools: vscode.LanguageModelChatTool[] | undefined;
    let toolMode: vscode.LanguageModelChatToolMode | undefined;

    if (opts.tools && opts.tools.length > 0 && opts.tool_choice !== "none") {
      vsCodeTools = opts.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description ?? "",
        inputSchema: t.function.parameters,
      }));

      if (opts.tool_choice === "required") {
        toolMode = vscode.LanguageModelChatToolMode.Required;
      } else {
        // "auto" or object (specific function) – use Auto; VS Code doesn't support forcing a specific tool
        toolMode = vscode.LanguageModelChatToolMode.Auto;
      }
    }

    // Build modelOptions with all supported sampling parameters (undefined values are omitted)
    const modelOpts: Record<string, unknown> = {};
    if (opts.temperature !== undefined) modelOpts.temperature = opts.temperature;
    if (opts.top_p !== undefined) modelOpts.top_p = opts.top_p;
    const tokenLimit = opts.max_completion_tokens ?? opts.max_tokens;
    if (tokenLimit !== undefined) modelOpts.max_tokens = tokenLimit;
    if (opts.stop !== undefined) modelOpts.stop = opts.stop;
    if (opts.seed !== undefined) modelOpts.seed = opts.seed;
    if (opts.presence_penalty !== undefined) modelOpts.presence_penalty = opts.presence_penalty;
    if (opts.frequency_penalty !== undefined) modelOpts.frequency_penalty = opts.frequency_penalty;
    if (opts.logit_bias !== undefined) modelOpts.logit_bias = opts.logit_bias;

    const vsCodeOpts: vscode.LanguageModelChatRequestOptions = {
      modelOptions: Object.keys(modelOpts).length > 0 ? modelOpts : undefined,
    };
    if (vsCodeTools) vsCodeOpts.tools = vsCodeTools;
    if (toolMode !== undefined) vsCodeOpts.toolMode = toolMode;
    return vsCodeOpts;
  }

  /**
   * Retry helper with exponential back-off for GitHub Copilot rate-limit errors.
   * When the VS Code LM API returns "Response contained no choices", Copilot is
   * throttling the request. We wait and retry up to MAX_ATTEMPTS times before
   * propagating the error to the HTTP layer.
   */
  async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAYS_MS = [2000, 5000, 10000];
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const isNoChoices =
          typeof err?.message === "string" && err.message.includes("Response contained no choices");
        if (isNoChoices && attempt < MAX_ATTEMPTS - 1) {
          const delayMs = RETRY_DELAYS_MS[attempt] ?? 10000;
          console.warn(
            `[CopilotConnect] ${label}: upstream rate-limited ("no choices"), retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
          );
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`${label}: unexpected exit from retry loop`);
  }

  // Chat handler using VS Code Language Model API
  const chatHandler = async (
    messages: ChatMessage[],
    modelId: string | null,
    options: RequestOptions,
  ): Promise<import("./server").ChatResult> => {
    return withRetry("chatHandler", async () => {
      try {
        const model = await resolveModel(modelId);
        const vsCodeMessages = convertMessages(messages, additionalContext || undefined, options.response_format);
        const vsCodeOptions = buildVsCodeOptions(options);

        const cancellation = new vscode.CancellationTokenSource();
        const chatResponse = await model.sendRequest(vsCodeMessages, vsCodeOptions, cancellation.token);

        let content = "";
        const toolCalls: import("./server").ToolCall[] = [];

        try {
          for await (const part of chatResponse.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
              content += part.value;
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
              toolCalls.push({
                id: part.callId,
                type: "function",
                function: {
                  name: part.name,
                  arguments: JSON.stringify(part.input),
                },
              });
            }
          }
        } finally {
          cancellation.dispose();
        }

        const normalizedContent = normalizeJsonObjectContent(content || null, options.response_format);

        const result: import("./server").ChatResult = {
          content: normalizedContent,
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        };
        if (toolCalls.length > 0) result.tool_calls = toolCalls;
        return result;
      } catch (err: any) {
        console.error("[CopilotConnect] Chat request failed:", err);
        throw err;
      }
    });
  };

  // Stream chat handler using VS Code Language Model API
  const streamChatHandler = async (
    messages: ChatMessage[],
    modelId: string | null,
    options: RequestOptions,
    onChunk: (delta: StreamChunkDelta) => void,
  ): Promise<{ usage?: UsageInfo; finish_reason?: string }> => {
    return withRetry("streamChatHandler", async () => {
      try {
        const model = await resolveModel(modelId);
        const vsCodeMessages = convertMessages(messages, additionalContext || undefined, options.response_format);
        const vsCodeOptions = buildVsCodeOptions(options);
        const cancellation = new vscode.CancellationTokenSource();

        const chatResponse = await model.sendRequest(vsCodeMessages, vsCodeOptions, cancellation.token);

        const pendingToolCalls: import("./server").ToolCall[] = [];
        let hasToolCalls = false;
        const jsonObjectMode = options.response_format?.type === "json_object";
        let bufferedJsonContent = "";

        try {
          for await (const part of chatResponse.stream) {
            if (part instanceof vscode.LanguageModelTextPart) {
              if (jsonObjectMode) {
                bufferedJsonContent += part.value;
              } else {
                onChunk({ content: part.value });
              }
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
              hasToolCalls = true;
              pendingToolCalls.push({
                id: part.callId,
                type: "function",
                function: {
                  name: part.name,
                  arguments: JSON.stringify(part.input),
                },
              });
            }
          }
        } finally {
          cancellation.dispose();
        }


        // Emit accumulated tool calls as a single delta chunk
        if (pendingToolCalls.length > 0) {
          onChunk({
            tool_calls: pendingToolCalls.map((tc, idx) => ({
              index: idx,
              id: tc.id,
              type: "function" as const,
              function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
          });
        }

        if (jsonObjectMode) {
          const normalizedJsonContent = normalizeJsonObjectContent(bufferedJsonContent || null, options.response_format);
          if (normalizedJsonContent) {
            onChunk({ content: normalizedJsonContent });
          }
        }

        return {
          finish_reason: hasToolCalls ? "tool_calls" : "stop",
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
      } catch (err: any) {
        console.error("[CopilotConnect] Stream chat request failed:", err);
        throw err;
      }
    }); // end withRetry
  };

  try {
    bridgeControl = await startBridge(currentPort, modelProvider, chatHandler, streamChatHandler, VERSION);
    serverDisposable = { dispose: () => bridgeControl!.stop() };
    context.subscriptions.push(serverDisposable!);
    isRunning = true;
    echoMode = false; // always start in Bridge mode
    updateStatusBar();
    vscode.window.showInformationMessage(`Copilot Connect started on port ${currentPort}`);
  } catch (err: any) {
    console.error("[CopilotConnect] Failed to start server:", err);
    vscode.window.showErrorMessage("Copilot Connect failed to start: " + String(err));
  }
}

function stopServer() {
  const config = vscode.workspace.getConfiguration("copilotConnect");
  const zh = config.get<string>("language", "en") === "zh";

  if (!isRunning) {
    vscode.window.showInformationMessage(zh ? "桥接未在运行" : "Bridge is not running");
    return;
  }

  if (serverDisposable) {
    serverDisposable.dispose();
    serverDisposable = undefined;
  }
  bridgeControl = undefined;
  echoMode = false;

  isRunning = false;
  updateStatusBar();
  vscode.window.showInformationMessage(zh ? "Copilot信使已停止" : "Copilot Connect stopped");
}

async function changePort(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration("copilotConnect");
  const zh = config.get<string>("language", "en") === "zh";

  const newPort = await vscode.window.showInputBox({
    prompt: zh ? "输入新端口号" : "Enter new port number",
    value: currentPort.toString(),
    validateInput: (value) => {
      const port = parseInt(value);
      if (isNaN(port) || port < 1024 || port > 65535) {
        return zh ? "端口必须在 1024 到 65535 之间" : "Port must be a number between 1024 and 65535";
      }
      return null;
    },
  });

  if (!newPort) {
    return;
  }

  const port = parseInt(newPort);
  await config.update("port", port, vscode.ConfigurationTarget.Global);
  currentPort = port;

  const restartMsg = zh ? `端口已更改为 ${port}。现在重启桥接？` : `Port changed to ${port}. Restart bridge now?`;
  const restart = await vscode.window.showInformationMessage(restartMsg, zh ? "重启" : "Restart", zh ? "稍后" : "Later");

  if (restart === (zh ? "重启" : "Restart")) {
    if (isRunning) {
      stopServer();
    }
    startServer(context);
  }
}

async function selectDefaultModel() {
  const config = vscode.workspace.getConfiguration("copilotConnect");
  const zh = config.get<string>("language", "en") === "zh";

  try {
    const models = await vscode.lm.selectChatModels();

    if (models.length === 0) {
      vscode.window.showWarningMessage(zh ? "没有可用的语言模型" : "No language models available");
      return;
    }

    const items = models.map((m) => ({
      label: m.name || m.id,
      description: `${m.vendor} - ${m.family || "N/A"}`,
      id: m.id,
    }));

    items.unshift({
      label: zh ? "(无 - 自动选择)" : "(None - Auto-select)",
      description: zh ? "自动选择最佳可用模型" : "Automatically select the best available model",
      id: "",
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: zh ? "选择桥接的默认模型" : "Select default model for the bridge",
    });

    if (selected === undefined) {
      return;
    }

    await config.update("defaultModel", selected.id, vscode.ConfigurationTarget.Global);
    updateStatusBar(); // Refresh status bar to show updated model

    if (selected.id) {
      const msg = zh ? `默认模型已设置为: ${selected.label}` : `Default model set to: ${selected.label}`;
      vscode.window.showInformationMessage(msg);
    } else {
      const msg = zh ? "默认模型已清除（自动选择）" : "Default model cleared (auto-select)";
      vscode.window.showInformationMessage(msg);
    }
  } catch (err: any) {
    const msg = zh ? "获取模型失败: " : "Failed to fetch models: ";
    vscode.window.showErrorMessage(msg + String(err));
  }
}

async function setAdditionalContext() {
  const config = vscode.workspace.getConfiguration("copilotConnect");
  const zh = config.get<string>("language", "en") === "zh";
  const currentContext = config.get<string>("additionalContext", "");

  const newContext = await vscode.window.showInputBox({
    prompt: zh ? "输入要添加到所有请求的附加上下文" : "Enter additional context to be added to all requests",
    value: currentContext,
    placeHolder: zh ? "例如：你是一个有帮助的编码助手..." : "e.g., You are a helpful coding assistant...",
  });

  if (newContext === undefined) {
    return;
  }

  await config.update("additionalContext", newContext, vscode.ConfigurationTarget.Global);

  if (newContext) {
    vscode.window.showInformationMessage(zh ? "附加上下文已更新" : "Additional context updated");
  } else {
    vscode.window.showInformationMessage(zh ? "附加上下文已清除" : "Additional context cleared");
  }
}

function toggleEchoMode() {
  const config = vscode.workspace.getConfiguration("copilotConnect");
  const zh = config.get<string>("language", "en") === "zh";

  if (!isRunning || !bridgeControl) {
    vscode.window.showWarningMessage(zh ? "当前Copilot信使未运行" : "Copilot Connect is not running");
    return;
  }

  echoMode = !echoMode;
  bridgeControl.setEchoMode(echoMode);
  updateStatusBar();

  const msg = echoMode
    ? zh
      ? "Copilot信使已切换到Echo模式"
      : "Copilot Connect switched to Echo mode"
    : zh
      ? "Copilot信使已切换到桥接模式"
      : "Copilot Connect switched to Bridge mode";
  vscode.window.showInformationMessage(msg);
}

async function changeLanguage() {
  const config = vscode.workspace.getConfiguration("copilotConnect");
  const currentLang = config.get<string>("language", "en");

  const items = [
    { label: "English", id: "en" },
    { label: "中文", id: "zh" },
  ];

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `${currentLang === "en" ? "Current language" : "当前语言"}: ${currentLang === "en" ? "English" : "中文"}`,
  });

  if (!selected) {
    return;
  }

  await config.update("language", selected.id, vscode.ConfigurationTarget.Global);
  updateStatusBar(); // Refresh status bar with new language
  const msg = selected.id === "zh" ? `语言已更改为: ${selected.label}` : `Language changed to: ${selected.label}`;
  vscode.window.showInformationMessage(msg);
}

export function deactivate() {
  if (serverDisposable) {
    serverDisposable.dispose();
  }

  if (statusBarItem) {
    statusBarItem.dispose();
  }
}

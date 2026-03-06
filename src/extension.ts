import * as vscode from "vscode";
import { startBridge } from "./server";

// Read version from package.json
const packageJson = require("../package.json");
const VERSION = packageJson.version;

let serverDisposable: vscode.Disposable | undefined;
let statusBarItem: vscode.StatusBarItem;
let isRunning = false;
let currentPort = 1288;

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

  // Auto-start the bridge
  startServer(context);
}

function updateStatusBar() {
  const config = vscode.workspace.getConfiguration("copilotConnect");
  const language = config.get<string>("language", "en");

  if (isRunning) {
    const text = language === "zh" ? `Copilot信使: 运行中, 端口` : `Copilot Connect: Running Port`;
    statusBarItem.text = `$(radio-tower) ${text}: ${currentPort}`;
    statusBarItem.tooltip = language === "zh" ? "点击打开Copilot信使菜单" : "Click to open Copilot Connect menu";
    statusBarItem.backgroundColor = undefined;
    statusBarItem.color = undefined;
  } else {
    const text = language === "zh" ? `Copilot信使: 已停止` : `Copilot Connect: Stopped`;
    statusBarItem.text = `$(circle-slash) ${text}`;
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

  // Chat handler using VS Code Language Model API
  const chatHandler = async (prompt: string, context: string | null, modelId: string | null) => {
    try {
      // Use default model if specified and no modelId provided
      const effectiveModelId = modelId || defaultModel || null;
      const effectiveContext = additionalContext ? `${additionalContext}\n\n${context || ""}` : context;

      // Select model - prefer specified modelId, otherwise use vendor filter
      const selector = effectiveModelId ? { id: effectiveModelId } : { vendor: "copilot" };
      let models = await vscode.lm.selectChatModels(selector);

      // If no models found with specific ID, fallback to any copilot model
      if (models.length === 0 && effectiveModelId) {
        console.warn(`[CopilotConnect] No model found for ${effectiveModelId}, falling back to default copilot models`);
        models = await vscode.lm.selectChatModels({ vendor: "copilot" });
      }

      if (models.length === 0) {
        throw new Error("No matching language model found");
      }

      // Ensure we use the correct model - find exact match if modelId specified
      let selectedModel = models[0];
      if (effectiveModelId && models.length > 0) {
        const exactMatch = models.find((m) => m.id === effectiveModelId);
        if (exactMatch) {
          selectedModel = exactMatch;
        } else {
          console.warn(`[CopilotConnect] ChatHandler: No exact match for ${effectiveModelId}, using first model: ${models[0].name}`);
        }
      }

      const [model] = [selectedModel];
      console.log(`[CopilotConnect] ChatHandler: model selected: ${model.id}(${model.name})`);

      // Prepare messages
      const messages = [vscode.LanguageModelChatMessage.User(effectiveContext ? `${effectiveContext}\n\n${prompt}` : prompt)];

      const chatResponse = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

      let fullResponse = "";
      for await (const fragment of chatResponse.text) {
        fullResponse += fragment;
      }

      return fullResponse;
    } catch (err: any) {
      console.error("[CopilotConnect] Chat request failed:", err);
      throw err;
    }
  };

  // Stream chat handler using VS Code Language Model API
  const streamChatHandler = async (prompt: string, context: string | null, modelId: string | null, onChunk: (chunk: string) => void) => {
    try {
      const effectiveModelId = modelId || defaultModel || null;
      const effectiveContext = additionalContext ? `${additionalContext}\n\n${context || ""}` : context;

      const selector = effectiveModelId ? { id: effectiveModelId } : { vendor: "copilot" };
      let models = await vscode.lm.selectChatModels(selector);

      // If no models found with specific ID, fallback to any copilot model
      if (models.length === 0 && effectiveModelId) {
        console.warn(`[CopilotConnect] No model found for ${effectiveModelId}, falling back to default copilot models`);
        models = await vscode.lm.selectChatModels({ vendor: "copilot" });
      }

      if (models.length === 0) {
        throw new Error("[CopilotConnect] No matching language model found");
      }

      // Ensure we use the correct model - find exact match if modelId specified
      let selectedModel = models[0];
      if (effectiveModelId && models.length > 0) {
        const exactMatch = models.find((m) => m.id === effectiveModelId);
        if (exactMatch) {
          selectedModel = exactMatch;
        } else {
          console.warn(`[CopilotConnect] StreamChatHandler: No exact match for ${effectiveModelId}, using first model: ${models[0].name}`);
        }
      }

      const [model] = [selectedModel];
      console.log(`[CopilotConnect] StreamChatHandler: model selected: ${model.id}(${model.name})`);

      const messages = [vscode.LanguageModelChatMessage.User(effectiveContext ? `${effectiveContext}\n\n${prompt}` : prompt)];

      const chatResponse = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

      for await (const fragment of chatResponse.text) {
        onChunk(fragment);
      }
    } catch (err: any) {
      console.error("[CopilotConnect] Stream chat request failed:", err);
      throw err;
    }
  };

  try {
    const stopFn = await startBridge(currentPort, modelProvider, chatHandler, streamChatHandler, VERSION);
    serverDisposable = { dispose: () => stopFn() };
    context.subscriptions.push(serverDisposable!);
    isRunning = true;
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

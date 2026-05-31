const { CodexRpcClient } = require("./rpc-client");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");
const { mapCodexMessageToRuntimeEvent } = require("./events");
const {
  extractAssistantText,
  extractFailureText,
  extractThreadId,
  extractTurnId,
  extractThreadIdFromParams,
  extractTurnIdFromParams,
  isAssistantItemCompleted,
} = require("./message-utils");
const { findModelByQuery } = require("./model-catalog");
const { SessionStore } = require("./session-store");
const { resolveCodexProjectToolMcpServerConfig } = require("./mcp-config");

function createCodexRuntimeAdapter(config) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "codex" });
  let client = null;
  let readyState = null;
  const configuredModel = normalizeText(config.codexModel);
  const configuredModelProvider = normalizeText(config.codexModelProvider);

  function resolveModel(model = "", storedParams = null) {
    if (configuredModel) {
      return configuredModel;
    }
    if (storedParams && normalizeText(storedParams.modelProvider) !== configuredModelProvider) {
      return "";
    }
    return normalizeText(model);
  }

  function ensureClient() {
    if (!client) {
      client = new CodexRpcClient({
        endpoint: config.codexEndpoint,
        codexCommand: config.codexCommand,
        env: process.env,
        extraWritableRoots: [config.stateDir],
        mcpServerConfig: resolveCodexProjectToolMcpServerConfig(),
      });
      installCodexTurnDiagnostics(client);
    }
    return client;
  }

  return {
    describe() {
      return {
        id: "codex",
        kind: "runtime",
        endpoint: config.codexEndpoint || "(spawn)",
        sessionsFile: config.sessionsFile,
        model: configuredModel,
        modelProvider: configuredModelProvider,
      };
    },
    createClient() {
      return ensureClient();
    },
    onEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      const runtimeClient = ensureClient();
      return runtimeClient.onMessage((message) => {
        const event = mapCodexMessageToRuntimeEvent(message);
        if (event) {
          listener(event, message);
        }
      });
    },
    getSessionStore() {
      return sessionStore;
    },
    getTurnCapabilities({ model = "" } = {}) {
      const forcedNativeImageInput = config.codexNativeImageInput;
      if (typeof forcedNativeImageInput === "boolean") {
        return {
          nativeImageInput: forcedNativeImageInput,
          toolImageRead: false,
        };
      }
      const effectiveModel = normalizeText(configuredModel) || normalizeText(model);
      const catalog = sessionStore.getAvailableModelCatalog();
      const catalogModel = findModelByQuery(catalog?.models, effectiveModel);
      return {
        nativeImageInput: hasImageInputModality(catalogModel),
        toolImageRead: false,
      };
    },
    async initialize() {
      const runtimeClient = ensureClient();
      if (readyState && runtimeClient.isReady && runtimeClient.isTransportReady()) {
        return readyState;
      }
      await runtimeClient.connect();
      await runtimeClient.initialize();
      const modelResponse = await runtimeClient.listModels().catch(() => null);
      const models = Array.isArray(modelResponse?.result?.data)
        ? modelResponse.result.data
        : [];
      if (models.length) {
        sessionStore.setAvailableModelCatalog(models);
      }
      readyState = {
        endpoint: config.codexEndpoint || "(spawn)",
        models,
      };
      return readyState;
    },
    async close() {
      if (client) {
        await client.close();
      }
      readyState = null;
      client = null;
    },
    async startFreshThreadDraft() {
      return {};
    },
    async respondApproval({ requestId, decision, result = null }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      if (requestId == null || String(requestId).trim() === "") {
        throw new Error("approval response requires a requestId");
      }
      const responsePayload = result && typeof result === "object"
        ? result
        : { decision: decision === "accept" ? "accept" : "decline" };
      await runtimeClient.sendResponse(requestId, responsePayload);
      return {
        requestId,
        ...(result && typeof result === "object"
          ? { result: responsePayload }
          : { decision: responsePayload.decision }),
      };
    },
    async cancelTurn({ threadId, turnId }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      await runtimeClient.cancelTurn({ threadId, turnId });
      return { threadId, turnId };
    },
    async resumeThread({ threadId }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      return runtimeClient.resumeThread({
        threadId,
        model: configuredModel,
        modelProvider: configuredModelProvider,
      });
    },
    async compactThread({ threadId }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      return runtimeClient.compactThread({ threadId });
    },
    async refreshThreadInstructions({ threadId, workspaceRoot, model = "", modelProvider = "" }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      const refreshText = buildInstructionRefreshText(config);
      const desiredModel = resolveModel(model, { modelProvider });
      await runtimeClient.resumeThread({
        threadId,
        model: desiredModel,
        modelProvider: configuredModelProvider,
      });
      const completion = waitForTurnCompletion(runtimeClient, threadId);
      await runtimeClient.sendUserMessage({
        threadId,
        text: refreshText,
        model: desiredModel,
        modelProvider: configuredModelProvider,
        workspaceRoot,
      });
      const result = await completion;
      return { threadId, ...result };
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    async sendTurn({ bindingKey, workspaceRoot, text, attachments = [], metadata = {}, model = "" }) {
      const runtimeClient = ensureClient();
      await this.initialize();

      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      const storedParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      const desiredModel = resolveModel(model, storedParams);
      const desiredModelProvider = configuredModelProvider;
      if (threadId && !runtimeParamsMatch(storedParams, {
        model: desiredModel,
        modelProvider: desiredModelProvider,
      })) {
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
        threadId = "";
      }
      sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
        model: desiredModel,
        modelProvider: desiredModelProvider,
      });
      let outboundText = text;
      if (!threadId) {
        const response = await runtimeClient.startThread({
          cwd: workspaceRoot,
          model: desiredModel,
          modelProvider: desiredModelProvider,
        });
        threadId = extractThreadId(response);
        if (!threadId) {
          throw new Error("thread/start did not return a thread id");
        }
        sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);
        outboundText = buildOpeningTurnText(config, text);
      } else {
        await runtimeClient.resumeThread({
          threadId,
          model: desiredModel,
          modelProvider: desiredModelProvider,
        }).catch(async () => {
          sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
          const recreated = await runtimeClient.startThread({
            cwd: workspaceRoot,
            model: desiredModel,
            modelProvider: desiredModelProvider,
          });
          threadId = extractThreadId(recreated);
          if (!threadId) {
            throw new Error("thread/start did not return a thread id");
          }
          sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);
          sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
            model: desiredModel,
            modelProvider: desiredModelProvider,
          });
          outboundText = buildOpeningTurnText(config, text);
        });
      }

      const response = await runtimeClient.sendUserMessage({
        threadId,
        text: outboundText,
        attachments,
        model: desiredModel,
        modelProvider: desiredModelProvider,
        workspaceRoot,
      });
      return {
        threadId,
        turnId: extractTurnId(response),
      };
    },
  };
}

module.exports = { createCodexRuntimeAdapter };

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function runtimeParamsMatch(storedParams, desiredParams) {
  return normalizeText(storedParams?.model) === normalizeText(desiredParams?.model)
    && normalizeText(storedParams?.modelProvider) === normalizeText(desiredParams?.modelProvider);
}

function hasImageInputModality(model) {
  const modalities = Array.isArray(model?.inputModalities) ? model.inputModalities : [];
  return modalities.some((item) => normalizeText(item).toLowerCase() === "image");
}

function waitForTurnCompletion(client, threadId) {
  return new Promise((resolve, reject) => {
    let activeTurnId = "";
    const itemOrder = [];
    const completedTextByItemId = new Map();

    const cleanup = () => {
      unsubscribe();
      clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("codex turn timed out"));
    }, 10 * 60_000);

    const unsubscribe = client.onMessage((message) => {
      const params = message?.params || {};
      if (extractThreadIdFromParams(params) !== threadId) {
        return;
      }

      if ((message?.method === "turn/started" || message?.method === "turn/start") && !activeTurnId) {
        activeTurnId = extractTurnIdFromParams(params);
        return;
      }

      if (isAssistantItemCompleted(message)) {
        const itemId = typeof params?.item?.id === "string" ? params.item.id.trim() : `item-${itemOrder.length + 1}`;
        if (!completedTextByItemId.has(itemId)) {
          itemOrder.push(itemId);
        }
        completedTextByItemId.set(itemId, extractAssistantText(params));
        return;
      }

      if (message?.method === "turn/failed") {
        cleanup();
        reject(new Error(extractFailureText(params)));
        return;
      }

      if (message?.method === "turn/completed") {
        const completedTurnId = extractTurnIdFromParams(params);
        if (activeTurnId && completedTurnId && completedTurnId !== activeTurnId) {
          return;
        }
        cleanup();
        const text = itemOrder
          .map((itemId) => completedTextByItemId.get(itemId) || "")
          .filter(Boolean)
          .join("\n\n")
          .trim();
        resolve({
          turnId: completedTurnId || activeTurnId,
          text: text || "Completed.",
        });
      }
    });
  });
}

// Per-turn diagnostics for codex. Tracks methods + item types observed between
// turn/started and turn/completed for each (threadId, turnId). When a turn ends
// without any AgentMessage carrying text, logs a [cyberboss-diag] warning so we
// can find out what the model actually emitted (tool calls only? reasoning only?
// agent message with empty content?). This is purely observational; it never
// alters the runtime event stream.
function installCodexTurnDiagnostics(runtimeClient) {
  if (!runtimeClient || typeof runtimeClient.onMessage !== "function") {
    return;
  }
  const turns = new Map();

  function ensureTurn(threadId, turnId) {
    const key = `${threadId}::${turnId || "-"}`;
    let entry = turns.get(key);
    if (!entry) {
      entry = {
        threadId,
        turnId,
        startedAt: Date.now(),
        methodCounts: new Map(),
        itemTypeCounts: new Map(),
        agentMessageItems: 0,
        agentMessageChars: 0,
      };
      turns.set(key, entry);
    }
    return entry;
  }

  function bump(map, key) {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + 1);
  }

  function fmtMap(map) {
    if (!map || map.size === 0) return "{}";
    const pairs = [];
    for (const [k, v] of map) pairs.push(`${k}=${v}`);
    return `{${pairs.join(",")}}`;
  }

  runtimeClient.onMessage((message) => {
    const method = typeof message?.method === "string" ? message.method : "";
    const params = message?.params || {};
    const threadId = extractThreadIdFromParams(params);
    if (!threadId) {
      return;
    }
    const turnId = extractTurnIdFromParams(params);

    if (method === "turn/started" || method === "turn/start") {
      ensureTurn(threadId, turnId);
      return;
    }

    const entry = ensureTurn(threadId, turnId);
    if (method) bump(entry.methodCounts, method);

    if (method === "item/completed") {
      const itemType = typeof params?.item?.type === "string" ? params.item.type : "(unknown)";
      bump(entry.itemTypeCounts, itemType);
      if (itemType.toLowerCase() === "agentmessage") {
        const text = extractAssistantText(params);
        entry.agentMessageItems += 1;
        entry.agentMessageChars += typeof text === "string" ? text.length : 0;
      }
    }

    if (method === "error" || method === "turn/error") {
      if (!Array.isArray(entry.errorEvents)) entry.errorEvents = [];
      let snippet = "";
      try { snippet = JSON.stringify(params).slice(0, 500); } catch { snippet = String(params).slice(0, 500); }
      entry.errorEvents.push(snippet);
    }

    if (method === "turn/completed" || method === "turn/failed") {
      const key = `${threadId}::${turnId || "-"}`;
      const finished = turns.get(key);
      turns.delete(key);
      if (!finished) return;
      if (method === "turn/failed") return;
      if (finished.agentMessageItems === 0 || finished.agentMessageChars === 0) {
        const elapsedMs = Date.now() - finished.startedAt;
        console.warn(
          `[cyberboss-diag] codex turn produced no agent text thread=${threadId} turn=${turnId || "-"} elapsedMs=${elapsedMs} agentMessages=${finished.agentMessageItems} agentChars=${finished.agentMessageChars} methods=${fmtMap(finished.methodCounts)} itemTypes=${fmtMap(finished.itemTypeCounts)}`
        );
        if (Array.isArray(finished.errorEvents) && finished.errorEvents.length) {
          for (const errEntry of finished.errorEvents) {
            console.warn(
              `[cyberboss-diag] codex error event thread=${threadId} turn=${turnId || "-"} payload=${errEntry}`
            );
          }
        }
      }
    }
  });

  // Cap memory: drop turns that never completed within 15min.
  setInterval(() => {
    const cutoff = Date.now() - 15 * 60_000;
    for (const [key, entry] of turns) {
      if (entry.startedAt < cutoff) turns.delete(key);
    }
  }, 5 * 60_000).unref?.();
}

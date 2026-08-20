importScripts("logger.js");

const SIGNALDOCK_CLIENT_NAMES_URL = "http://localhost:3000/target/client-names";
const EXTENSION_LOG_STORAGE_KEY = "extensionLogs";
const MAX_EXTENSION_LOG_ENTRIES = 3000;
const MAX_EXTENSION_LOG_BYTES = 7 * 1024 * 1024;
let extensionLogWriteQueue = Promise.resolve();

function retainLogsWithinLimits(logs) {
  const retainedNewestFirst = [];
  let retainedBytes = 2;

  for (let index = logs.length - 1; index >= 0; index--) {
    if (retainedNewestFirst.length >= MAX_EXTENSION_LOG_ENTRIES) break;

    let entryBytes;
    try {
      entryBytes = new TextEncoder().encode(JSON.stringify(logs[index])).length + 1;
    } catch {
      entryBytes = 256;
    }

    if (retainedNewestFirst.length > 0 && retainedBytes + entryBytes > MAX_EXTENSION_LOG_BYTES) {
      break;
    }
    retainedNewestFirst.push(logs[index]);
    retainedBytes += entryBytes;
  }

  return retainedNewestFirst.reverse();
}

function appendExtensionLog(entry) {
  extensionLogWriteQueue = extensionLogWriteQueue
    .then(async () => {
      const result = await chrome.storage.local.get(EXTENSION_LOG_STORAGE_KEY);
      const logs = Array.isArray(result[EXTENSION_LOG_STORAGE_KEY])
        ? result[EXTENSION_LOG_STORAGE_KEY]
        : [];
      logs.push(entry);
      const trimmedLogs = retainLogsWithinLimits(logs);
      await chrome.storage.local.set({ [EXTENSION_LOG_STORAGE_KEY]: trimmedLogs });
    })
    .catch((error) => {
      if (globalThis.TMHLogger && globalThis.TMHLogger.originalConsole) {
        globalThis.TMHLogger.originalConsole.error("[TMH Logger] Storage write failed:", error);
      }
    });

  return extensionLogWriteQueue;
}

globalThis.TMHLogStore = { append: appendExtensionLog };

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "APPEND_EXTENSION_LOG") {
    const entry = {
      ...(message.entry && typeof message.entry === "object" ? message.entry : {}),
      tabId: sender.tab && sender.tab.id !== undefined ? sender.tab.id : null
    };
    appendExtensionLog(entry).then(() => sendResponse({ success: true }));
    return true;
  }

  if (message.action !== "GET_SIGNALDOCK_CLIENT_NAMES") return false;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  fetch(SIGNALDOCK_CLIENT_NAMES_URL, {
    method: "GET",
    cache: "no-store",
    signal: controller.signal,
    headers: {
      Accept: "application/json"
    }
  })
    .then(async (response) => {
      let body;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      if (!response.ok) {
        const messageText = body && body.msg
          ? String(body.msg)
          : `SignalDock returned HTTP ${response.status}`;
        throw new Error(messageText);
      }

      if (!Array.isArray(body)) {
        throw new Error("SignalDock response must be an array of seller names");
      }

      console.log(`[SignalDock] Background worker loaded ${body.length} seller names`);
      sendResponse({
        success: true,
        names: body.filter((name) => typeof name === "string")
      });
    })
    .catch((error) => {
      console.error("[SignalDock] Background API request failed:", error);
      sendResponse({
        success: false,
        names: [],
        error: error && error.name === "AbortError"
          ? "SignalDock request timed out"
          : (error && error.message ? error.message : "SignalDock request failed")
      });
    })
    .finally(() => clearTimeout(timeoutId));

  return true;
});

const SIGNALDOCK_API_BASE_URL = "http://192.168.0.250:43127/target";
const SIGNALDOCK_CLIENT_NAMES_URL = `${SIGNALDOCK_API_BASE_URL}/client-names`;
const SIGNALDOCK_CREATE_CLIENT_URL = `${SIGNALDOCK_API_BASE_URL}/create-client`;
const PRODUCT_TAB_LOAD_TIMEOUT_MS = 45000;
const PRODUCT_EXTRACTION_TIMEOUT_MS = 75000;
const AUTOMATION_WATCHDOG_ALARM = "target-mail-hunter-watchdog";
const AUTOMATION_WATCHDOG_STALE_MS = 3 * 60 * 1000;
const activeProductTabs = new Set();
let automationStopGeneration = 0;
let automationStoppedByUser = false;

function ensureAutomationWatchdogAlarm() {
  chrome.alarms.create(AUTOMATION_WATCHDOG_ALARM, { periodInMinutes: 1 });
}

async function restartAutomationTab(tabId, reason) {
  if (!Number.isInteger(tabId)) return false;

  const stopGeneration = automationStopGeneration;
  const stored = await chrome.storage.local.get("automationWatchdog");
  if (stopGeneration !== automationStopGeneration) return false;
  const current = stored.automationWatchdog && typeof stored.automationWatchdog === "object"
    ? stored.automationWatchdog
    : {};
  const restartCount = Number(current.restartCount || 0) + 1;

  await chrome.storage.local.set({
    automationWatchdog: {
      ...current,
      desiredRunning: true,
      forceRestart: true,
      lastHeartbeat: Date.now(),
      lastStage: `restart-requested: ${reason}`,
      restartCount
    },
    automationResumeState: null,
    automationAttemptedSellerIds: []
  });
  if (stopGeneration !== automationStopGeneration) return false;

  console.warn(`[Watchdog] Reloading category tab ${tabId}: ${reason}`, { restartCount });
  return new Promise((resolve) => {
    chrome.tabs.reload(tabId, {}, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        console.error(`[Watchdog] Could not reload category tab ${tabId}:`, runtimeError.message);
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

ensureAutomationWatchdogAlarm();

chrome.runtime.onInstalled.addListener(ensureAutomationWatchdogAlarm);
chrome.runtime.onStartup.addListener(ensureAutomationWatchdogAlarm);
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove("extensionLogs").catch((error) => {
    console.error("[Logs] Could not clear previously stored logs:", error);
  });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || alarm.name !== AUTOMATION_WATCHDOG_ALARM) return;

  const stored = await chrome.storage.local.get("automationWatchdog");
  const watchdog = stored.automationWatchdog;
  if (!watchdog || watchdog.desiredRunning !== true || !Number.isInteger(watchdog.tabId)) return;

  const heartbeatAge = Date.now() - Number(watchdog.lastHeartbeat || 0);
  if (Number.isFinite(heartbeatAge) && heartbeatAge <= AUTOMATION_WATCHDOG_STALE_MS) return;

  await restartAutomationTab(
    watchdog.tabId,
    `no heartbeat for ${Math.max(0, Math.round(heartbeatAge / 1000))} seconds`
  );
});

function errorMessage(error) {
  return error && error.message ? error.message : String(error || "Unknown error");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createProductTab(url, openerTabId, openerWindowId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({
      url,
      active: true,
      ...(Number.isInteger(openerTabId) ? { openerTabId } : {}),
      ...(Number.isInteger(openerWindowId) ? { windowId: openerWindowId } : {})
    }, (tab) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      if (!tab || !Number.isInteger(tab.id)) {
        reject(new Error("Chrome did not return a product tab ID"));
        return;
      }
      resolve(tab);
    });
  });
}

function waitForTabComplete(tabId, timeoutMs = PRODUCT_TAB_LOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };

    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      finish(resolve, tab);
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId !== tabId) return;
      finish(reject, new Error("Product tab was closed before it finished loading"));
    };

    const timeoutId = setTimeout(() => {
      finish(reject, new Error(`Product tab load timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    // The tab can finish between chrome.tabs.create() and listener registration.
    chrome.tabs.get(tabId, (tab) => {
      if (settled) return;
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        finish(reject, new Error(runtimeError.message));
        return;
      }
      if (tab && tab.status === "complete") finish(resolve, tab);
    });
  });
}

function navigateTabAndWait(tabId, url, timeoutMs = PRODUCT_TAB_LOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };

    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
      finish(resolve, tab);
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId !== tabId) return;
      finish(reject, new Error("Product tab was closed during seller-page navigation"));
    };

    const timeoutId = setTimeout(() => {
      finish(reject, new Error(`Seller page navigation timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.update(tabId, { url }, (tab) => {
      if (settled) return;
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        finish(reject, new Error(runtimeError.message));
        return;
      }
      // Covers a cached navigation that completed before the update callback.
      if (tab && tab.status === "complete" && tab.url === url) finish(resolve, tab);
    });
  });
}

function sendTabMessage(tabId, message, timeoutMs = PRODUCT_EXTRACTION_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Product extraction timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);

      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function sendTabMessageWithRetries(tabId, message, attempts = 10, delayMs = 500) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await sendTabMessage(tabId, message);
    } catch (error) {
      lastError = error;
      const messageText = errorMessage(error);
      const receiverNotReady = /receiving end does not exist|could not establish connection/i.test(messageText);
      if (!receiverNotReady || attempt === attempts) throw error;

      console.warn(`Product content script is not ready (${attempt}/${attempts}); retrying...`);
      await delay(delayMs);
    }
  }

  throw lastError || new Error("Product content script did not become ready");
}

async function sendWorkflowResultToTab(tabId, clientRequestId, response, attempts = 10) {
  if (!Number.isInteger(tabId) || !clientRequestId) return false;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const delivered = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, {
        action: "PRODUCT_WORKFLOW_RESULT_V11",
        clientRequestId,
        response
      }, (acknowledgement) => {
        const runtimeError = chrome.runtime.lastError;
        resolve(Boolean(
          !runtimeError &&
          acknowledgement &&
          acknowledgement.received === true
        ));
      });
    });

    if (delivered) return true;
    if (attempt < attempts) await delay(500);
  }

  return false;
}

function closeTab(tabId, requestId = "unknown-request") {
  if (!Number.isInteger(tabId)) return;

  chrome.tabs.remove(tabId, () => {
    const runtimeError = chrome.runtime.lastError;
    if (runtimeError) {
      console.warn(`[Product ${requestId}] Product tab cleanup warning: ${runtimeError.message}`);
      return;
    }
    console.log(`[Product ${requestId}] Product tab close confirmed`, { productTabId: tabId });
  });
}

function activateTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  chrome.tabs.update(tabId, { active: true }, () => {
    void chrome.runtime.lastError;
  });
}

async function processTargetProduct(message, sender) {
  const taskGeneration = automationStopGeneration;
  const requestId = message.clientRequestId ||
    `product-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const openerTabId = sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
  const openerWindowId = sender.tab && Number.isInteger(sender.tab.windowId)
    ? sender.tab.windowId
    : null;
  let productTabId = null;
  let phase = "validate-request";

  try {
    const productUrl = new URL(String(message.productUrl || ""));
    if (productUrl.protocol !== "https:" || productUrl.hostname !== "www.target.com") {
      throw new Error("The product URL is not an allowed Target URL");
    }

    console.log(`[Product ${requestId}] Phase: create-tab`, productUrl.href);
    phase = "create-tab";
    const productTab = await createProductTab(productUrl.href, openerTabId, openerWindowId);
    productTabId = productTab.id;
    activeProductTabs.add(productTabId);
    if (taskGeneration !== automationStopGeneration) throw new Error("Automation stopped by user");

    console.log(`[Product ${requestId}] Phase: wait-for-load`, { productTabId });
    phase = "wait-for-load";
    const loadedTab = await waitForTabComplete(productTabId);
    if (taskGeneration !== automationStopGeneration) throw new Error("Automation stopped by user");

    console.log(`[Product ${requestId}] Phase: discover-seller-link`, {
      productTabId,
      loadedUrl: loadedTab && loadedTab.url ? loadedTab.url : "unknown"
    });
    phase = "discover-seller-link";
    const discovery = await sendTabMessageWithRetries(productTabId, {
      action: "DISCOVER_PRODUCT_SELLER_V9",
      requestId,
      sellerId: String(message.sellerId || ""),
      sellerIndex: Number(message.sellerIndex) || 0
    });
    if (taskGeneration !== automationStopGeneration) throw new Error("Automation stopped by user");

    if (!discovery || discovery.success !== true) {
      throw new Error(discovery && discovery.error
        ? discovery.error
        : "Product tab returned an invalid seller-discovery response");
    }

    let sellerData = discovery.sellerData || null;
    if (!sellerData) {
      const sellerUrl = new URL(String(discovery.sellerUrl || ""));
      if (sellerUrl.protocol !== "https:" || sellerUrl.hostname !== "www.target.com") {
        throw new Error("The discovered seller URL is not an allowed Target URL");
      }

      console.log(`[Product ${requestId}] Phase: navigate-seller-page`, sellerUrl.href);
      phase = "navigate-seller-page";
      const sellerTab = await navigateTabAndWait(productTabId, sellerUrl.href);
      if (taskGeneration !== automationStopGeneration) throw new Error("Automation stopped by user");

      console.log(`[Product ${requestId}] Phase: extract-contact`, {
        productTabId,
        loadedUrl: sellerTab && sellerTab.url ? sellerTab.url : "unknown"
      });
      phase = "extract-contact";
      const contactResponse = await sendTabMessageWithRetries(productTabId, {
        action: "EXTRACT_SELLER_CONTACT_V9",
        requestId,
        sellerId: String(message.sellerId || ""),
        sellerIndex: Number(message.sellerIndex) || 0
      });

      if (!contactResponse || contactResponse.success !== true || !contactResponse.sellerData) {
        throw new Error(contactResponse && contactResponse.error
          ? contactResponse.error
          : "Seller page returned an invalid contact-extraction response");
      }
      sellerData = contactResponse.sellerData;
    }

    console.log(`[Product ${requestId}] Phase: complete`, { productTabId });
    return { success: true, sellerData, requestId };
  } catch (error) {
    console.error(`[Product ${requestId}] Failed during ${phase}:`, error);
    return {
      success: false,
      error: errorMessage(error),
      phase,
      requestId
    };
  } finally {
    if (productTabId !== null) {
      activeProductTabs.delete(productTabId);
      console.log(`[Product ${requestId}] Phase: close-tab`, { productTabId });
      // Cleanup must never delay the response to the category content script.
      // chrome.tabs.remove() can finish independently after its request is queued.
      closeTab(productTabId, requestId);
    }
    activateTab(openerTabId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "STOP_ALL_AUTOMATION_V1") {
    automationStopGeneration++;
    automationStoppedByUser = true;
    const productTabIds = [...activeProductTabs];
    activeProductTabs.clear();
    for (const tabId of productTabIds) closeTab(tabId, "stop-all");

    chrome.tabs.query({ url: "https://www.target.com/*" }, async (tabs) => {
      const queryError = chrome.runtime.lastError;
      if (queryError) {
        sendResponse({ success: false, error: queryError.message });
        return;
      }
      for (const tab of tabs) {
        if (!Number.isInteger(tab.id)) continue;
        chrome.tabs.sendMessage(tab.id, { action: "STOP_ALL_AUTOMATION_V1" }, () => {
          void chrome.runtime.lastError;
        });
      }

      try {
        const stored = await chrome.storage.local.get("automationWatchdog");
        const watchdog = stored.automationWatchdog && typeof stored.automationWatchdog === "object"
          ? stored.automationWatchdog
          : {};
        await chrome.storage.local.set({
          automationWatchdog: {
            ...watchdog,
            desiredRunning: false,
            forceRestart: false,
            lastHeartbeat: Date.now(),
            lastStage: "stopped-by-user"
          },
          automationResumeState: null,
          automationAttemptedSellerIds: []
        });
        sendResponse({ success: true, stoppedTabs: tabs.length, closedProductTabs: productTabIds.length });
      } catch (error) {
        sendResponse({ success: false, error: errorMessage(error) });
      }
    });
    return true;
  }

  if (message.action === "AUTOMATION_WATCHDOG_UPDATE_V11") {
    if (automationStoppedByUser && message.stage !== "manual-start") {
      sendResponse({ success: true, stopped: true });
      return false;
    }
    if (message.stage === "manual-start") automationStoppedByUser = false;
    const tabId = sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
    chrome.storage.local.get("automationWatchdog").then((stored) => {
      const current = stored.automationWatchdog && typeof stored.automationWatchdog === "object"
        ? stored.automationWatchdog
        : {};
      return chrome.storage.local.set({
        automationWatchdog: {
          ...current,
          tabId,
          categoryPathname: String(message.categoryPathname || current.categoryPathname || ""),
          desiredRunning: message.desiredRunning === true,
          forceRestart: message.forceRestart === true,
          lastHeartbeat: Date.now(),
          lastStage: String(message.stage || "unknown")
        }
      });
    })
      .then(() => sendResponse({ success: true, tabId }))
      .catch((error) => {
        console.error("[Watchdog] Could not store heartbeat:", error);
        sendResponse({ success: false, error: errorMessage(error) });
      });
    return true;
  }

  if (message.action === "REQUEST_AUTOMATION_RESTART_V11") {
    const tabId = sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
    restartAutomationTab(tabId, String(message.reason || "content script requested restart"))
      .then((restarted) => sendResponse({ success: restarted }));
    return true;
  }

  if (message.action === "PROCESS_TARGET_PRODUCT_V9") {
    if (automationStoppedByUser) {
      sendResponse({ success: false, phase: "stopped-by-user", error: "Automation stopped by user" });
      return false;
    }
    const openerTabId = sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
    processTargetProduct(message, sender)
      .then(async (response) => {
        console.log(`[Product ${response.requestId || "unknown-request"}] Sending direct workflow result`);
        const directResultDelivered = await sendWorkflowResultToTab(
          openerTabId,
          message.clientRequestId,
          response
        );
        console.log(`[Product ${response.requestId || "unknown-request"}] Direct workflow result delivery`, {
          delivered: directResultDelivered
        });
        console.log(`[Product ${response.requestId || "unknown-request"}] Sending workflow response`, {
          success: response.success,
          phase: response.phase || "complete"
        });
        sendResponse(response);
      })
      .catch((error) => {
        console.error("Unexpected product workflow failure before response:", error);
        sendResponse({
          success: false,
          phase: "background-unhandled-error",
          error: errorMessage(error)
        });
      });
    return true;
  }

  if (message.action === "CREATE_SIGNALDOCK_CLIENT_V1") {
    const email = String(message.email || "").trim();
    const information = message.information && typeof message.information === "object"
      ? message.information
      : null;
    if (!email || !information) {
      sendResponse({ success: false, error: "A client email and information object are required" });
      return false;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    fetch(SIGNALDOCK_CREATE_CLIENT_URL, {
      method: "POST",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, information })
    })
      .then(async (response) => {
        const responseText = await response.text();
        let body = null;
        try {
          body = responseText ? JSON.parse(responseText) : null;
        } catch {
          body = null;
        }
        if (body && (body.status === false || body.success === false)) {
          throw new Error(body.msg || body.message || "SignalDock rejected the client record");
        }
        if (!response.ok) {
          throw new Error(body && (body.msg || body.message)
            ? String(body.msg || body.message)
            : `SignalDock returned HTTP ${response.status}`);
        }
        sendResponse({ success: true, status: response.status, body });
      })
      .catch((error) => {
        sendResponse({
          success: false,
          error: error && error.name === "AbortError"
            ? "SignalDock create-client request timed out"
            : (error && error.message ? error.message : "SignalDock create-client request failed")
        });
      })
      .finally(() => clearTimeout(timeoutId));
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
      console.warn("[SignalDock] Background API request unavailable; offline fallback may be used:", error);
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

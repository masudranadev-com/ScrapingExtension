const SIGNALDOCK_API_BASE_URL = "http://192.168.0.250:43127/target";
const SIGNALDOCK_CLIENT_NAMES_URL = `${SIGNALDOCK_API_BASE_URL}/client-names`;
const SIGNALDOCK_CREATE_CLIENT_URL = `${SIGNALDOCK_API_BASE_URL}/create-client`;
const PRODUCT_TAB_LOAD_TIMEOUT_MS = 45000;
const PRODUCT_EXTRACTION_TIMEOUT_MS = 75000;
const AUTOMATION_WATCHDOG_ALARM = "target-mail-hunter-watchdog";
const AUTOMATION_WATCHDOG_STALE_MS = 3 * 60 * 1000;
const MAX_AUTOMATIC_STALL_RESTARTS = 3;
const activeProductTabs = new Set();
let automationStopGeneration = 0;
let automationStoppedByUser = false;
const KEYWORDS = [
  "Trending Products", "Best Selling Products", "Viral TikTok Products",
  "Trending Fashion Products", "Beauty and Skincare Products", "Smart Home Gadgets",
  "Mobile Accessories", "Home and Kitchen Gadgets", "Women's Fashion", "Men's Fashion",
  "Kids and Baby Products", "Fitness and Wellness Products", "Electronic Gadgets",
  "Home Decor Products", "Travel Accessories", "Watches and Accessories",
  "Shoes and Sneakers", "Pet Accessories", "Winter Fashion Collection", "Gift and Lifestyle Products"
];
const KEYWORD_CATALOG_KEYS = ["sellerNames", "sellerData", "currentSellerIndex", "categoryName",
  "breadcrumbSteps", "totalSellers", "newSellers", "sellerCatalogCategoryName",
  "automationResumeState", "automationAttemptedSellerIds", "automationFacet"];
let keywordOperations = Promise.resolve();
let filterDiagnosticWrites = Promise.resolve();

function serializeKeywordOperation(operation) {
  const result = keywordOperations.then(operation);
  keywordOperations = result.catch(() => {});
  return result;
}

async function removeOldPlaceholderEmails() {
  const stored = await chrome.storage.local.get(["sellerData", "sellerNames", "keywordResults"]);
  let changed = false;
  const cleanSeller = seller => {
    if (!seller || seller.is_placeholder_email !== true) return seller;
    changed = true;
    return { ...seller, email: "", is_placeholder_email: false, sold_by_missing: true, status: "Completed" };
  };
  const sellerData = Array.isArray(stored.sellerData) ? stored.sellerData.map(cleanSeller) : stored.sellerData;
  const completedIds = new Set((sellerData || []).filter(seller => seller && seller.sold_by_missing === true).map(seller => String(seller.unique_id || "")).filter(Boolean));
  const sellerNames = Array.isArray(stored.sellerNames) ? stored.sellerNames.map(seller =>
    seller && completedIds.has(String(seller.unique_id || "")) ? { ...seller, status: "Completed" } : seller) : stored.sellerNames;
  const keywordResults = Array.isArray(stored.keywordResults) ? stored.keywordResults.map(result =>
    result && Array.isArray(result.sellers) ? { ...result, sellers: result.sellers.map(cleanSeller) } : result) : stored.keywordResults;
  if (changed) {
    const update = {};
    if (Array.isArray(sellerData)) update.sellerData = sellerData;
    if (Array.isArray(sellerNames)) update.sellerNames = sellerNames;
    if (Array.isArray(keywordResults)) update.keywordResults = keywordResults;
    await chrome.storage.local.set(update);
  }
}

async function navigateToKeyword(state) {
  const url = new URL("https://www.target.com/s");
  url.searchParams.set("searchTerm", KEYWORDS[state.index]);
  await chrome.tabs.update(state.tabId, { url: url.href, active: true });
}

async function pauseKeywordQueue(reason) {
  const { keywordQueue } = await chrome.storage.local.get("keywordQueue");
  if (!keywordQueue || keywordQueue.status !== "running") return;
  automationStopGeneration++;
  await chrome.storage.local.set({ keywordQueue: { ...keywordQueue, status: "paused", error: reason || "Automation paused" },
    automationWatchdog: { desiredRunning: false, lastStage: "keyword-paused" } });
  automationStoppedByUser = true;
  for (const tabId of activeProductTabs) closeTab(tabId, "keyword-paused");
  activeProductTabs.clear();
  chrome.tabs.sendMessage(keywordQueue.tabId, { action: "STOP_ALL_AUTOMATION_V1" }, () => { void chrome.runtime.lastError; });
}

async function findRestartTab(preferredTabId, fallbackTabId) {
  for (const tabId of new Set([preferredTabId, fallbackTabId])) {
    if (!Number.isInteger(tabId)) continue;
    try {
      const tab = await chrome.tabs.get(tabId);
      const url = new URL(tab.url || "");
      if (url.protocol === "https:" && url.hostname === "www.target.com") return tabId;
    } catch {
      // The original tab may have been closed or navigated away.
    }
  }
  return null;
}

async function restartKeywordQueue(queue, fallbackTabId, automatic = false) {
  if (!queue) throw new Error("There is no saved keyword run to restart. Press Start first.");
  if (queue.status === "completed") throw new Error("All keywords are complete. Reset to start again.");
  if (queue.status === "running") await pauseKeywordQueue(automatic ? "Restarting after a stall" : "Restarting by request");
  const tabId = await findRestartTab(queue.tabId, fallbackTabId);
  if (tabId === null) {
    const error = "The saved Target tab is unavailable. Open a Target page and press Restart.";
    await chrome.storage.local.set({ keywordQueue: { ...queue, status: "paused", error },
      automationWatchdog: { desiredRunning: false, lastStage: "restart-tab-unavailable" } });
    throw new Error(error);
  }
  const state = { ...queue, tabId, status: "running", error: "", runId: crypto.randomUUID(),
    autoRestartCount: automatic ? Number(queue.autoRestartCount || 0) + 1 : 0,
    lastRestartReason: automatic ? "watchdog stall" : "manual restart" };
  automationStopGeneration++;
  automationStoppedByUser = false;
  await chrome.storage.local.set({ keywordQueue: state, automationResumeState: null,
    automationWatchdog: { desiredRunning: true, tabId, lastHeartbeat: Date.now(), lastStage: "loading-keyword" } });
  try { await navigateToKeyword(state); } catch (error) { await pauseKeywordQueue(errorMessage(error)); throw error; }
  return { success: true };
}

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
chrome.runtime.onInstalled.addListener(() => {
  void serializeKeywordOperation(removeOldPlaceholderEmails).catch(error => console.error("Could not remove old placeholder emails:", error));
});
chrome.runtime.onStartup.addListener(ensureAutomationWatchdogAlarm);
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm || alarm.name !== AUTOMATION_WATCHDOG_ALARM) return;

  const stored = await chrome.storage.local.get("automationWatchdog");
  const watchdog = stored.automationWatchdog;
  if (!watchdog || watchdog.desiredRunning !== true || !Number.isInteger(watchdog.tabId)) return;

  const heartbeatAge = Date.now() - Number(watchdog.lastHeartbeat || 0);
  if (Number.isFinite(heartbeatAge) && heartbeatAge <= AUTOMATION_WATCHDOG_STALE_MS) return;

  await serializeKeywordOperation(async () => {
    const current = await chrome.storage.local.get(["automationWatchdog", "keywordQueue"]);
    const latest = current.automationWatchdog;
    if (!latest || latest.desiredRunning !== true || latest.tabId !== watchdog.tabId ||
        Date.now() - Number(latest.lastHeartbeat || 0) <= AUTOMATION_WATCHDOG_STALE_MS ||
        !current.keywordQueue || current.keywordQueue.tabId !== watchdog.tabId) return;
    const reason = `No progress for ${Math.max(0, Math.round((Date.now() - Number(latest.lastHeartbeat || 0)) / 1000))} seconds.`;
    if (Number(current.keywordQueue.autoRestartCount || 0) >= MAX_AUTOMATIC_STALL_RESTARTS) {
      await pauseKeywordQueue(`${reason} Automatic restart limit reached; press Restart to retry.`);
      return;
    }
    try {
      await restartKeywordQueue(current.keywordQueue, null, true);
    } catch (error) {
      console.warn("[Watchdog] Could not restart the keyword:", errorMessage(error));
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void serializeKeywordOperation(async () => {
    const { keywordQueue } = await chrome.storage.local.get("keywordQueue");
    if (keywordQueue && keywordQueue.status === "running" && keywordQueue.tabId === tabId) {
      await pauseKeywordQueue("The Target search tab was closed. Open a Target page and press Start to resume.");
    }
  });
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
  if (message.action === "FILTER_DIAGNOSTIC") {
    if (!sender.tab || !message.entry || typeof message.entry !== "object") {
      sendResponse({ success: false });
      return false;
    }
    filterDiagnosticWrites = filterDiagnosticWrites.catch(() => {}).then(async () => {
      const { filterDiagnostics } = await chrome.storage.local.get("filterDiagnostics");
      const entries = Array.isArray(filterDiagnostics) ? filterDiagnostics : [];
      const entry = message.entry;
      entries.push({ timestamp: String(entry.timestamp || "").slice(0, 40),
        stage: String(entry.stage || "").slice(0, 100), path: String(entry.path || "").slice(0, 500),
        keywordIndex: Number.isInteger(entry.keywordIndex) ? entry.keywordIndex : null,
        optionId: String(entry.optionId || "").slice(0, 200), optionName: String(entry.optionName || "").slice(0, 200),
        error: String(entry.error || "").slice(0, 1000), label: String(entry.label || "").slice(0, 200),
        applyStage: String(entry.stageName || "").slice(0, 50), attempt: Number(entry.attempt) || 0,
        buttons: Array.isArray(entry.buttons) ? entry.buttons.slice(0, 12).map(button => ({
          label: String(button.label || "").slice(0, 200), visible: Boolean(button.visible), disabled: Boolean(button.disabled)
        })) : [] });
      await chrome.storage.local.set({ filterDiagnostics: entries.slice(-300) });
    });
    filterDiagnosticWrites.then(() => sendResponse({ success: true }), error => sendResponse({ success: false, error: errorMessage(error) }));
    return true;
  }
  if (["KEYWORD_START", "KEYWORD_RESTART", "KEYWORD_STOP", "KEYWORD_RESET", "KEYWORD_PAGE_READY", "KEYWORD_COMPLETE", "KEYWORD_ERROR"].includes(message.action)) {
    serializeKeywordOperation(async () => {
      const { keywordQueue } = await chrome.storage.local.get("keywordQueue");
      if (message.action === "KEYWORD_RESTART") return restartKeywordQueue(keywordQueue, message.tabId, false);
      if (message.action === "KEYWORD_START") {
        if (!Number.isInteger(message.tabId)) throw new Error("Open a Target page before starting.");
        if (keywordQueue && keywordQueue.status === "running") throw new Error("The keyword queue is already running.");
        if (keywordQueue && keywordQueue.status === "completed") throw new Error("All keywords are complete. Reset to start again.");
        const index = keywordQueue && Number.isInteger(keywordQueue.index) ? keywordQueue.index : 0;
        const state = { index, keyword: KEYWORDS[index], status: "running", tabId: message.tabId, error: "", runId: crypto.randomUUID(), autoRestartCount: 0 };
        automationStoppedByUser = false;
        automationStopGeneration++;
        if (!keywordQueue) await chrome.storage.local.remove(KEYWORD_CATALOG_KEYS);
        const update = { keywordQueue: state, automationResumeState: null, automationWatchdog: { desiredRunning: true, tabId: state.tabId, lastHeartbeat: Date.now(), lastStage: "loading-keyword" } };
        if (!keywordQueue) update.automationAttemptedSellerIds = [];
        await chrome.storage.local.set(update);
        try { await navigateToKeyword(state); } catch (error) { await pauseKeywordQueue(errorMessage(error)); throw error; }
        return { success: true };
      }
      if (message.action === "KEYWORD_STOP" || message.action === "KEYWORD_RESET") {
        automationStopGeneration++;
        automationStoppedByUser = true;
        if (keywordQueue && keywordQueue.status === "running") await pauseKeywordQueue("Stopped by user");
        for (const tabId of activeProductTabs) closeTab(tabId, "stop-all");
        activeProductTabs.clear();
        if (keywordQueue && Number.isInteger(keywordQueue.tabId)) {
          chrome.tabs.sendMessage(keywordQueue.tabId, { action: "STOP_ALL_AUTOMATION_V1" }, () => { void chrome.runtime.lastError; });
        }
        await chrome.storage.local.set({ automationWatchdog: { desiredRunning: false, lastStage: "stopped-by-user" }, automationResumeState: null });
        if (message.action === "KEYWORD_RESET") await chrome.storage.local.remove(["keywordQueue", ...KEYWORD_CATALOG_KEYS]);
        return { success: true };
      }
      if (!keywordQueue || keywordQueue.status !== "running" || !sender.tab || sender.tab.id !== keywordQueue.tabId) return { success: false };
      if (message.action === "KEYWORD_PAGE_READY") {
        const url = new URL(sender.tab.url);
        return { success: url.pathname === "/s" && url.searchParams.get("searchTerm") === KEYWORDS[keywordQueue.index], index: keywordQueue.index, runId: keywordQueue.runId };
      }
      if (message.index !== keywordQueue.index || message.runId !== keywordQueue.runId) return { success: false };
      if (message.action === "KEYWORD_ERROR") {
        await pauseKeywordQueue(String(message.error || "Automation failed"));
        return { success: true };
      }
      const stored = await chrome.storage.local.get(["keywordResults", "sellerData"]);
      const results = Array.isArray(stored.keywordResults) ? stored.keywordResults : [];
      results.push({ keyword: keywordQueue.keyword, completedAt: new Date().toISOString(), sellers: Array.isArray(stored.sellerData) ? stored.sellerData : [] });
      const nextIndex = keywordQueue.index + 1;
      if (nextIndex >= KEYWORDS.length) {
        await chrome.storage.local.set({ keywordResults: results, keywordQueue: { ...keywordQueue, status: "completed", error: "" }, automationWatchdog: { desiredRunning: false, lastStage: "keywords-complete" } });
        return { success: true };
      }
      const next = { ...keywordQueue, index: nextIndex, keyword: KEYWORDS[nextIndex], error: "", runId: crypto.randomUUID() };
      await chrome.storage.local.set({ keywordResults: results, keywordQueue: next,
        sellerNames: [], sellerData: [], currentSellerIndex: 0, categoryName: "", breadcrumbSteps: [],
        totalSellers: 0, newSellers: 0, sellerCatalogCategoryName: "", automationResumeState: null,
        automationAttemptedSellerIds: [], automationFacet: "", automationWatchdog: { desiredRunning: true, tabId: next.tabId, lastHeartbeat: Date.now(), lastStage: "loading-keyword" } });
      try { await navigateToKeyword(next); } catch (error) { await pauseKeywordQueue(errorMessage(error)); throw error; }
      return { success: true };
    }).then(sendResponse).catch(error => sendResponse({ success: false, error: errorMessage(error) }));
    return true;
  }
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
    const tabId = sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
    serializeKeywordOperation(async () => {
      const stored = await chrome.storage.local.get(["automationWatchdog", "keywordQueue"]);
      if (message.runId && (!stored.keywordQueue || stored.keywordQueue.status !== "running" || stored.keywordQueue.runId !== message.runId || stored.keywordQueue.tabId !== tabId)) return { success: false, stopped: true };
      if (automationStoppedByUser && message.stage !== "manual-start") return { success: false, stopped: true };
      if (message.stage === "manual-start") automationStoppedByUser = false;
      const current = stored.automationWatchdog && typeof stored.automationWatchdog === "object"
        ? stored.automationWatchdog
        : {};
      const update = {
        automationWatchdog: {
          ...current,
          tabId,
          categoryPathname: String(message.categoryPathname || current.categoryPathname || ""),
          desiredRunning: message.desiredRunning === true,
          forceRestart: message.forceRestart === true,
          lastHeartbeat: Date.now(),
          lastStage: String(message.stage || "unknown")
        }
      };
      if (message.runId && message.stage === "seller-completed" && stored.keywordQueue.autoRestartCount) {
        update.keywordQueue = { ...stored.keywordQueue, autoRestartCount: 0 };
      }
      await chrome.storage.local.set(update);
      return { success: true, tabId };
    })
      .then(sendResponse)
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
    const requestGeneration = automationStopGeneration;
    const allowed = message.runId
      ? chrome.storage.local.get("keywordQueue").then(({ keywordQueue }) => Boolean(keywordQueue && keywordQueue.status === "running" && keywordQueue.runId === message.runId && keywordQueue.tabId === openerTabId))
      : Promise.resolve(true);
    allowed.then((isAllowed) => {
      if (!isAllowed || automationStoppedByUser || requestGeneration !== automationStopGeneration) throw new Error("Automation stopped or the keyword run changed");
      return processTargetProduct(message, sender);
    })
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

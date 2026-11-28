let isRunning = false;
const startButton = document.getElementById("start");
const viewDataButton = document.getElementById("viewData");
const stopAllButton = document.getElementById("stopAll");
const signalDockClientNamesUrl = "http://192.168.0.250:43127/target/client-names";
const SIGNALDOCK_ERROR_LOG_LIMIT = 100;
let signalDockSyncPromise = null;

function setLocalStorage(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function getLocalStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

async function logSignalDockError(stage, message, details = {}) {
  const stored = await getLocalStorage("signalDockErrorLog");
  const history = Array.isArray(stored.signalDockErrorLog) ? stored.signalDockErrorLog : [];
  const entry = {
    timestamp: new Date().toISOString(),
    stage,
    endpoint: signalDockClientNamesUrl,
    message: String(message || "SignalDock request failed"),
    ...details
  };

  await setLocalStorage({
    signalDockLastError: entry,
    signalDockErrorLog: [entry, ...history].slice(0, SIGNALDOCK_ERROR_LOG_LIMIT)
  });
  console.error("[SignalDock] Client-name sync failure", entry);
}

function normalizeSellerName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function hasFoundSellerEmail(seller) {
  const email = String((seller && seller.email) || "").trim().toLowerCase();
  return Boolean(email) && !email.includes("not found");
}

function hasCompletedSoldByLookup(seller) {
  if (!seller) return false;

  return [seller.email, seller.error_reason].some((value) => {
    const normalized = String(value || "")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const isSoldByIssue = (
      normalized.includes("sold & shipped by") ||
      normalized.includes("sold and shipped by")
    );
    return isSoldByIssue && normalized.includes("not found");
  });
}

function requestSignalDockFromBackground() {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(
      `Background request timed out after 12 seconds for ${signalDockClientNamesUrl}`
    )), 12000);

    chrome.runtime.sendMessage({ action: "GET_SIGNALDOCK_CLIENT_NAMES" }, (response) => {
      clearTimeout(timeoutId);

      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response || response.success !== true || !Array.isArray(response.names)) {
        reject(new Error(response && response.error ? response.error : "Invalid background response"));
        return;
      }

      resolve(response.names);
    });
  });
}

async function requestSignalDockDirectly() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(signalDockClientNamesUrl, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
    const responseText = await response.text();
    let body;

    try {
      body = JSON.parse(responseText);
    } catch {
      throw new Error(`SignalDock returned invalid JSON (HTTP ${response.status})`);
    }

    if (!response.ok) {
      throw new Error(
        body && body.msg ? String(body.msg) : `SignalDock returned HTTP ${response.status}`
      );
    }
    if (!Array.isArray(body)) {
      throw new Error("SignalDock response must be an array of seller names");
    }

    return body;
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error(`Direct SignalDock request timed out for ${signalDockClientNamesUrl}`);
    }
    throw new Error(
      `Direct SignalDock request failed for ${signalDockClientNamesUrl}: ${error && error.message ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

async function saveSignalDockResult(names) {
  const result = await getLocalStorage(["sellerData", "sellerNames"]);
  const storedSellerData = Array.isArray(result.sellerData) ? result.sellerData : [];
  const storedSellerNames = Array.isArray(result.sellerNames) ? result.sellerNames : [];
  const sourceRows = storedSellerData.length > 0 ? storedSellerData : storedSellerNames;
  const existingClientNames = new Set(
    names
      .map(normalizeSellerName)
      .filter((name) => name && name !== "not found" && name !== "null")
  );
  const seenSellerNames = new Set();
  let newSellerCount = 0;

  const updatedRows = sourceRows.map((seller) => {
    const normalizedName = normalizeSellerName(seller.seller_name || seller.business_name);
    const isExistingClient = Boolean(normalizedName) && existingClientNames.has(normalizedName);
    const isDuplicateSeller = Boolean(normalizedName) && seenSellerNames.has(normalizedName);
    if (normalizedName) seenSellerNames.add(normalizedName);

    const isNewSeller = Boolean(normalizedName) && !isExistingClient && !isDuplicateSeller;
    const status = (
      isExistingClient ||
      isDuplicateSeller ||
      hasCompletedSoldByLookup(seller) ||
      hasFoundSellerEmail(seller)
    ) ? "Found" : "Not Found";
    if (isNewSeller) newSellerCount++;

    return {
      ...seller,
      status,
      is_existing_client: isExistingClient,
      is_duplicate_seller: isDuplicateSeller,
      is_new_seller: isNewSeller
    };
  });

  const updatedById = new Map(
    updatedRows
      .filter((seller) => seller && seller.unique_id)
      .map((seller) => [String(seller.unique_id), seller])
  );
  const updatedSellerNames = storedSellerNames.length > 0
    ? storedSellerNames.map((seller) => {
        const updated = updatedById.get(String(seller.unique_id || ""));
        return updated ? {
          ...seller,
          status: updated.status,
          is_existing_client: updated.is_existing_client,
          is_duplicate_seller: updated.is_duplicate_seller,
          is_new_seller: updated.is_new_seller
        } : seller;
      })
    : updatedRows.map((seller, index) => ({
        id: seller.id || index + 1,
        unique_id: seller.unique_id || "",
        seller_name: seller.seller_name || seller.business_name || "Not found",
        status: seller.status,
        is_existing_client: seller.is_existing_client,
        is_duplicate_seller: seller.is_duplicate_seller,
        is_new_seller: seller.is_new_seller
      }));

  const storageUpdate = {
    signalDockClientNames: names,
    signalDockClientNamesSucceeded: true,
    signalDockClientNamesError: "",
    signalDockClientNamesCheckedAt: new Date().toISOString(),
    clientNameCheckSucceeded: true,
    clientNameCheckError: "",
    clientNameCheckedAt: new Date().toISOString(),
    newSellers: newSellerCount
  };
  if (storedSellerData.length > 0) storageUpdate.sellerData = updatedRows;
  if (updatedSellerNames.length > 0) storageUpdate.sellerNames = updatedSellerNames;

  await setLocalStorage(storageUpdate);
  return newSellerCount;
}

function syncSignalDockClientNames() {
  if (signalDockSyncPromise) return signalDockSyncPromise;

  signalDockSyncPromise = (async () => {
    let backgroundError = "";
    let directError = "";
    try {
      let body;
      try {
        body = await requestSignalDockFromBackground();
      } catch (error) {
        backgroundError = error && error.message ? error.message : "Background request failed";
        console.warn("[SignalDock] Background request failed; trying direct request:", backgroundError);
        try {
          body = await requestSignalDockDirectly();
        } catch (directRequestError) {
          directError = directRequestError && directRequestError.message
            ? directRequestError.message
            : "Direct request failed";
          throw new Error(`Background: ${backgroundError}; Direct: ${directError}`);
        }
      }

      const names = body.filter((name) => typeof name === "string");
      const newSellerCount = await saveSignalDockResult(names);
      console.log(`[SignalDock] Loaded ${names.length} existing seller names; ${newSellerCount} new sellers`);
      return { success: true, names, error: "" };
    } catch (error) {
      const errorMessage = error && error.message ? error.message : "SignalDock request failed";
      await setLocalStorage({
        signalDockClientNamesSucceeded: false,
        signalDockClientNamesError: errorMessage,
        signalDockClientNamesCheckedAt: new Date().toISOString(),
        clientNameCheckSucceeded: false,
        clientNameCheckError: errorMessage,
        clientNameCheckedAt: new Date().toISOString()
      });
      await logSignalDockError("client-names-sync", errorMessage, {
        backgroundError,
        directError
      });
      console.warn("[SignalDock] API request unavailable; cached/offline mode will be used:", errorMessage);
      return { success: false, names: [], error: errorMessage };
    } finally {
      signalDockSyncPromise = null;
    }
  })();

  return signalDockSyncPromise;
}

const resetButton = document.getElementById("reset");
const restartButton = document.getElementById("restart");
const progress = document.getElementById("progress");
const downloadDebugButton = document.getElementById("downloadDebug");

downloadDebugButton.addEventListener("click", async () => {
  const { filterDiagnostics, keywordQueue, automationWatchdog } = await chrome.storage.local.get(["filterDiagnostics", "keywordQueue", "automationWatchdog"]);
  const blob = new Blob([JSON.stringify({ keywordQueue, automationWatchdog, filterDiagnostics: filterDiagnostics || [] }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "target-filter-debug.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

async function refreshProgress() {
  const { keywordQueue } = await chrome.storage.local.get("keywordQueue");
  if (!keywordQueue) {
    progress.textContent = "Ready to start keyword 1 of 20";
    startButton.disabled = false;
    restartButton.disabled = true;
    return;
  }
  const label = `Keyword ${keywordQueue.index + 1} of 20: ${keywordQueue.keyword || ""}`;
  progress.textContent = `${label} - ${keywordQueue.status}${keywordQueue.autoRestartCount ? ` (automatic restart ${keywordQueue.autoRestartCount}/3)` : ""}${keywordQueue.error ? `: ${keywordQueue.error}` : ""}`;
  startButton.disabled = keywordQueue.status === "running" || keywordQueue.status === "completed";
  restartButton.disabled = keywordQueue.status === "completed";
}

async function sendQueueCommand(action, extra = {}) {
  const response = await chrome.runtime.sendMessage({ action, ...extra });
  if (!response || !response.success) throw new Error(response?.error || "The operation failed.");
  await refreshProgress();
}

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !Number.isInteger(tab.id) || !tab.url?.startsWith("https://www.target.com/")) {
      throw new Error("Open a Target page before starting.");
    }
    await sendQueueCommand("KEYWORD_START", { tabId: tab.id });
  } catch (error) {
    alert(error.message);
    await refreshProgress();
  }
});

restartButton.addEventListener("click", async () => {
  restartButton.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await sendQueueCommand("KEYWORD_RESTART", { tabId: tab && tab.id });
  } catch (error) {
    alert(error.message);
    await refreshProgress();
  }
});

viewDataButton.addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") }));

for (const [button, action] of [[stopAllButton, "KEYWORD_STOP"], [resetButton, "KEYWORD_RESET"]]) {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await sendQueueCommand(action); }
    catch (error) { alert(error.message); }
    finally { button.disabled = false; }
  });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.keywordQueue) void refreshProgress();
});
void refreshProgress();

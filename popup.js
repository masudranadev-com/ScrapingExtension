let isRunning = false;
const startButton = document.getElementById("start");
const viewDataButton = document.getElementById("viewData");
const viewLogsButton = document.getElementById("viewLogs");
const signalDockClientNamesUrl = "http://localhost:3000/target/client-names";
let signalDockSyncPromise = null;

function setLocalStorage(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function getLocalStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
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
    const timeoutId = setTimeout(() => reject(new Error("Background request timed out")), 12000);

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
      throw new Error("Direct SignalDock request timed out");
    }
    throw error;
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
    try {
      let body;
      let backgroundError = "";
      try {
        body = await requestSignalDockFromBackground();
      } catch (error) {
        backgroundError = error && error.message ? error.message : "Background request failed";
        console.warn("[SignalDock] Background request failed; trying direct request:", backgroundError);
        try {
          body = await requestSignalDockDirectly();
        } catch (directError) {
          const directMessage = directError && directError.message
            ? directError.message
            : "Direct request failed";
          throw new Error(`Background: ${backgroundError}; Direct: ${directMessage}`);
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
      console.error("[SignalDock] API request failed:", errorMessage, error);
      return { success: false, names: [], error: errorMessage };
    } finally {
      signalDockSyncPromise = null;
    }
  })();

  return signalDockSyncPromise;
}

async function ensureLatestContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["logger.js", "content.js"]
    });
    return true;
  } catch (error) {
    console.warn("Could not load the latest content script:", error);
    return false;
  }
}

async function sendSellerDiscoveryMessage() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab || !tab.id || !tab.url || !tab.url.startsWith("https://www.target.com/")) {
    return;
  }

  await syncSignalDockClientNames();

  const loaded = await ensureLatestContentScript(tab.id);
  if (!loaded) return;

  chrome.tabs.sendMessage(tab.id, { action: "COLLECT_SELLER_NAMES_V9" }, () => {
    void chrome.runtime.lastError;
  });
}

// Opening the extension popup starts the lightweight name/count scan.
sendSellerDiscoveryMessage();

// Start/Stop button
startButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!isRunning) {
    await syncSignalDockClientNames();

    const loaded = await ensureLatestContentScript(tab.id);
    if (!loaded) return;

    chrome.tabs.sendMessage(tab.id, { action: "START_AUTOMATION_V9" }, () => {
      if (chrome.runtime.lastError) return;
      window.close();
    });
  } else {
    // Stop automation
    chrome.tabs.sendMessage(tab.id, { action: "STOP_AUTOMATION_V9" }, () => {
      if (chrome.runtime.lastError) {
        console.warn("Content script not available:", chrome.runtime.lastError.message);
      }
    });

    // Change button back to Start
    startButton.textContent = "▶ Start";
    startButton.style.background = "#ffffff";
    startButton.style.color = "#ff3b3b";
    isRunning = false;
  }
});

// View Data button
viewDataButton.addEventListener("click", async () => {
  await syncSignalDockClientNames();
  chrome.tabs.create({
    url: chrome.runtime.getURL('viewer.html')
  });
});

viewLogsButton.addEventListener("click", () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("log.html")
  });
});

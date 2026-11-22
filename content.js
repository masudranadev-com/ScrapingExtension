// --------------------
// Prevent duplicate injection
// --------------------
if (window.__targetMailHunterVersion === "9.0.6") {
  console.log("Content script already loaded, skipping re-injection");
} else {
window.__targetMailHunterVersion = "9.0.6";
window.__targetMailHunterLoaded = true;

// --------------------
// Global state
// --------------------
let shouldStopAutomation = false;
let isAutomationRunning = false;
let sellerDiscoveryPromise = null;
let automationGeneration = 0;
let automationHeartbeatTimer = null;
const pendingProductRequests = window.__targetMailHunterPendingProductRequests instanceof Map
  ? window.__targetMailHunterPendingProductRequests
  : new Map();
window.__targetMailHunterPendingProductRequests = pendingProductRequests;

// --------------------
// Utility helpers
// --------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function updateAutomationWatchdog(desiredRunning, stage, forceRestart = false) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      action: "AUTOMATION_WATCHDOG_UPDATE_V11",
      desiredRunning,
      forceRestart,
      stage,
      categoryPathname: window.location.pathname
    }, (response) => {
      void chrome.runtime.lastError;
      resolve(response || null);
    });
  });
}

function startAutomationHeartbeat(stage = "automation-running") {
  if (automationHeartbeatTimer) clearInterval(automationHeartbeatTimer);
  void updateAutomationWatchdog(true, stage, false);
  automationHeartbeatTimer = null;
}

function reportAutomationProgress(stage) {
  void updateAutomationWatchdog(true, stage, false);
}

function stopAutomationHeartbeat() {
  if (!automationHeartbeatTimer) return;
  clearInterval(automationHeartbeatTimer);
  automationHeartbeatTimer = null;
}

async function finishAutomationRun(stage = "complete") {
  stopAutomationHeartbeat();
  await updateAutomationWatchdog(false, stage, false);
}

async function requestAutomationRestart(reason) {
  stopAutomationHeartbeat();
  console.error(`🔁 Requesting complete automation restart: ${reason}`);
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      action: "REQUEST_AUTOMATION_RESTART_V11",
      reason
    }, (response) => {
      void chrome.runtime.lastError;
      resolve(Boolean(response && response.success));
    });
  });
}

function scrollToAndClick(element) {
  if (!element) return false;

  element.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
  try {
    element.focus({ preventScroll: true });
  } catch {
    // Some non-form elements do not support focus; clicking can still continue.
  }
  element.click();
  return true;
}

function click(selector) {
  const el = document.querySelector(selector);
  if (el) {
    return scrollToAndClick(el);
  }
  console.warn("Element not found:", selector);
  return false;
}

// --------------------
// Message listener
// --------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "PRODUCT_WORKFLOW_RESULT_V11") {
    const pendingRequest = pendingProductRequests.get(msg.clientRequestId);
    if (!pendingRequest) {
      console.log("Product workflow result was already handled or belongs to an older run", {
        clientRequestId: msg.clientRequestId || "missing"
      });
      sendResponse({ received: true, matched: false });
      return false;
    }

    console.log("Product workflow result received directly from background", {
      clientRequestId: msg.clientRequestId,
      success: Boolean(msg.response && msg.response.success),
      phase: msg.response && msg.response.phase ? msg.response.phase : "complete"
    });
    pendingRequest.resolve(msg.response);
    sendResponse({ received: true, matched: true });
    return false;
  }

  if (msg.action === "DISCOVER_PRODUCT_SELLER_V9" || msg.action === "EXTRACT_SELLER_CONTACT_V9") {
    const requestId = msg.requestId || "unknown-request";
    const isDiscovery = msg.action === "DISCOVER_PRODUCT_SELLER_V9";
    console.log(`[Product ${requestId}] Content script received ${isDiscovery ? "seller discovery" : "contact extraction"} request`, {
      readyState: document.readyState,
      pageUrl: window.location.href
    });

    const task = isDiscovery
      ? discoverSellerFromCurrentProduct(msg.sellerId, msg.sellerIndex, requestId)
      : extractSellerContactFromCurrentPage(msg.sellerId, msg.sellerIndex, requestId);

    task
      .then((result) => {
        if (!result || (!result.sellerData && !result.sellerUrl)) {
          throw new Error("Product workflow step finished without seller data or a seller URL");
        }
        sendResponse({ success: true, ...result });
      })
      .catch((error) => {
        const errorText = error && error.message ? error.message : String(error);
        console.error(`[Product ${requestId}] Content extraction failed:`, error);
        sendResponse({ success: false, error: errorText });
      });

    return true;
  }

  if (msg.action === "START_AUTOMATION_V10") {
    if (isAutomationRunning) {
      console.log("⚠️ Automation already running, ignoring duplicate start");
      return;
    }
    shouldStopAutomation = false;
    isAutomationRunning = true;
    const startGeneration = ++automationGeneration;
    updateAutomationWatchdog(true, "manual-start", false)
      .then(() => setStorage({
        automationAttemptedSellerIds: [],
        automationResumeState: null
      }))
      .then(() => getSignalDockClientNames(true))
      .then(async (clientCheck) => {
        if (startGeneration !== automationGeneration || shouldStopAutomation) {
          sendResponse({ success: false, error: "Automation was stopped" });
          return;
        }
        if (!clientCheck.success) {
          await finishAutomationRun("client-list-sync-failed");
          isAutomationRunning = false;
          sendResponse({ success: false, error: clientCheck.error });
          return;
        }
        sendResponse({ success: true });
        isAutomationRunning = false;
        void runAutomation(clientCheck).catch((error) => {
          console.error("Automation run failed:", error);
        });
      })
      .catch((error) => {
        isAutomationRunning = false;
        void finishAutomationRun("start-initialization-failed");
        console.error("Could not initialize the automation run:", error);
        sendResponse({ success: false, error: error && error.message ? error.message : String(error) });
      });
    return true;
  } else if (msg.action === "COLLECT_SELLER_NAMES_V10") {
    startSellerDiscovery();
  } else if (msg.action === "STOP_AUTOMATION_V10" || msg.action === "STOP_ALL_AUTOMATION_V1") {
    automationGeneration++;
    shouldStopAutomation = true;
    isAutomationRunning = false;
    for (const pendingRequest of pendingProductRequests.values()) {
      pendingRequest.resolve({ success: false, phase: "stopped-by-user", error: "Automation stopped by user" });
    }
    pendingProductRequests.clear();
    stopAutomationHeartbeat();
    void updateAutomationWatchdog(false, "stopped-by-user", false);
    console.log("🛑 STOP requested by user");
  }

  return false;
});

// --------------------
// Category & Breadcrumb extraction
// --------------------
function extractCategoryName() {
  const heading = document.querySelector('h1[data-test="page-title"]');
  if (heading) {
    const name = heading.textContent.trim();
    console.log(`📂 Category name: ${name}`);
    return name;
  }
  console.warn("⚠️ Category name not found on page");
  return null;
}

function extractBreadcrumbSteps() {
  const breadcrumbNav = document.querySelector('nav[aria-label="Breadcrumbs"]');
  if (!breadcrumbNav) {
    console.warn("⚠️ Breadcrumb nav not found on page");
    return [];
  }

  const links = breadcrumbNav.querySelectorAll('a[data-test="@web/Breadcrumbs/BreadcrumbLink"]');
  const steps = [];
  for (const link of links) {
    steps.push({
      name: link.textContent.trim(),
      href: link.getAttribute("href")
    });
  }

  console.log(`🧭 Breadcrumb steps: ${steps.map(s => s.name).join(" > ")}`);
  return steps;
}

async function saveCategoryData(categoryName, breadcrumbSteps) {
  await setStorage({
    categoryName: categoryName,
    breadcrumbSteps: breadcrumbSteps
  });
  console.log("💾 Category data saved to cache");
}

// --------------------
// Main flow
// --------------------
async function openFiltersAndSellerPanel(maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (shouldStopAutomation) return false;

    reportAutomationProgress(`open-filters-attempt-${attempt}`);
    console.log(`🔄 [Attempt ${attempt}/${maxRetries}] Opening Filters + Seller panel...`);

    // Open Filters
    console.log("🖱️  Clicking: Filters menu");
    click('[data-test="filters-menu"]');
    await sleep(800);

    const modalOpen = await verifyModalOpen();
    if (!modalOpen) {
      console.warn(`⚠️ Filters modal didn't open (attempt ${attempt}/${maxRetries}), retrying...`);
      await sleep(2000);
      continue;
    }

    // Open Sold by
    console.log("🖱️  Clicking: Sold by button");
    click('[data-test="facet-group-d_sellers_all"]');
    await sleep(1200);

    const sellerPanelOpen = await verifySellerPanelOpen();
    if (!sellerPanelOpen) {
      console.warn(`⚠️ Seller panel didn't open (attempt ${attempt}/${maxRetries}), retrying...`);
      // Close modal and try again
      const closeBtn = document.querySelector('[data-test="modal-close-button"]') || document.querySelector('button[aria-label="close"]');
      if (closeBtn) scrollToAndClick(closeBtn);
      await sleep(2000);
      continue;
    }

    console.log("✅ Filters + Seller panel opened successfully");
    return true;
  }

  console.error(`❌ Failed to open Filters/Seller panel after ${maxRetries} attempts`);
  return false;
}

async function recoverToProductListing(maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (shouldStopAutomation) return false;

    console.log(`🔄 [Recovery ${attempt}/${maxRetries}] Trying to get back to product listing...`);

    // Check if we're already on listing
    const onListing = await verifyProductListingPage(3000);
    if (onListing) return true;

    // The category tab is never intentionally navigated now. Close any modal,
    // return to the product grid position, and allow Target time to re-render.
    const closeButton = document.querySelector('[data-test="modal-close-button"]') ||
      document.querySelector('button[aria-label="close"], button[aria-label="Close"]');
    if (closeButton) scrollToAndClick(closeButton);
    window.scrollTo({ top: 0, behavior: "auto" });
    await sleep(3000);

    const backWorked = await verifyProductListingPage(5000);
    if (backWorked) return true;

    console.warn(`⚠️ Recovery attempt ${attempt} failed, retrying...`);
    await sleep(2000);
  }
  return false;
}

async function runAutomation(syncedClientCheck = null) {
  const runGeneration = automationGeneration;
  const wasStopped = () => shouldStopAutomation || runGeneration !== automationGeneration;
  isAutomationRunning = true;
  startAutomationHeartbeat("run-automation");
  console.log("🚀 Automation started");

  try {
    // Wait for the popup-open discovery scan before starting the full run.
    if (sellerDiscoveryPromise) {
      await sellerDiscoveryPromise;
    }
    if (wasStopped()) return;

    // Every process start/restart must validate against the shared database.
    const liveClientCheck = syncedClientCheck || await getSignalDockClientNames(true);
    if (wasStopped()) return;
    if (!liveClientCheck.success) {
      console.error(`[SignalDock] Cannot start automation without a live client-list sync: ${liveClientCheck.error}`);
      await finishAutomationRun("client-list-sync-failed");
      return;
    }

    // Extract and cache category info
    const categoryName = extractCategoryName();
    const breadcrumbSteps = extractBreadcrumbSteps();
    if (categoryName) {
      await saveCategoryData(categoryName, breadcrumbSteps);
    }
    if (wasStopped()) return;

    const cachedCatalog = await getCachedSellerCatalog(null, categoryName || "");
    if (cachedCatalog.valid) {
      await refreshCachedSignalDockStatuses(cachedCatalog, liveClientCheck);
    }
    if (wasStopped()) return;

    // Open Filters + Seller panel with retries
    const opened = await openFiltersAndSellerPanel();
    if (wasStopped()) return;
    if (!opened) {
      console.error("❌ Could not open filters/seller panel after all retries.");
      await requestAutomationRestart("filters/seller panel could not be opened");
      return;
    }

    // Collect emails
    await collectSellerEmails();
  } finally {
    stopAutomationHeartbeat();
    isAutomationRunning = false;
  }
}

// --------------------
// Storage helpers (JSON in chrome.storage.local)
// --------------------
function getStorage(key, fallback) {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get([key], (result) => {
        if (chrome.runtime.lastError) {
          resolve(fallback);
          return;
        }
        resolve(result[key] ?? fallback);
      });
      return;
    }

    // Fallback to localStorage if chrome.storage is unavailable
    try {
      const raw = localStorage.getItem(key);
      resolve(raw ? JSON.parse(raw) : fallback);
    } catch {
      resolve(fallback);
    }
  });
}

function setStorage(obj) {
  return new Promise((resolve) => {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set(obj, () => resolve());
      return;
    }

    try {
      Object.keys(obj).forEach((key) => {
        localStorage.setItem(key, JSON.stringify(obj[key]));
      });
    } catch {
      // ignore
    }
    resolve();
  });
}

function isMissingBusinessName(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return !normalized || normalized === "n/a" || normalized.startsWith("not found");
}

function hasFoundSellerEmail(seller) {
  const email = String((seller && seller.email) || "").trim().toLowerCase();
  return Boolean(email) && !email.includes("not found");
}

function isUsableSellerEmail(value) {
  const email = String(value || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/not found/i.test(email);
}

function createSignalDockClient(seller) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      action: "CREATE_SIGNALDOCK_CLIENT_V1",
      email: String(seller.email || "").trim(),
      information: {
        business_name: String(seller.business_name || seller.seller_name || "").trim(),
        seller_name: String(seller.seller_name || seller.business_name || "").trim(),
        store_link: String(seller.store_link || "").trim()
      }
    }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { success: false, error: "SignalDock returned no create-client response" });
    });
  });
}

async function queueSignalDockClient(seller) {
  const email = String(seller.email || "").trim();
  const pendingValue = await getStorage("signalDockPendingClients", []);
  const pending = Array.isArray(pendingValue) ? pendingValue : [];
  const record = {
    email,
    information: {
      business_name: String(seller.business_name || seller.seller_name || "").trim(),
      seller_name: String(seller.seller_name || seller.business_name || "").trim(),
      store_link: String(seller.store_link || "").trim()
    }
  };
  const key = email.toLowerCase();
  const existingIndex = pending.findIndex((item) => String(item.email || "").trim().toLowerCase() === key);
  if (existingIndex >= 0) pending[existingIndex] = record;
  else pending.push(record);
  await setStorage({ signalDockPendingClients: pending });
}

async function flushPendingSignalDockClients() {
  const pendingValue = await getStorage("signalDockPendingClients", []);
  const pending = Array.isArray(pendingValue) ? pendingValue : [];
  if (pending.length === 0) return;

  const remaining = [];
  for (const client of pending) {
    const response = await createSignalDockClient({
      email: client.email,
      ...(client.information || {})
    });
    if (!response.success) {
      console.warn(`[SignalDock] Pending client upload will retry later for ${client.email}: ${response.error}`);
      remaining.push(client);
    }
  }
  await setStorage({ signalDockPendingClients: remaining });
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

function normalizeSellerName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function hasFoundSellerStatus(seller) {
  return Boolean(
    seller && (
      String(seller.status || "").trim().toLowerCase() === "found" ||
      seller.is_existing_client === true ||
      seller.is_duplicate_seller === true ||
      hasCompletedSoldByLookup(seller) ||
      hasFoundSellerEmail(seller)
    )
  );
}

async function getSignalDockClientNames(forceRefresh = false) {
  const [cachedNames, cachedSuccess, cachedError] = await Promise.all([
    getStorage("signalDockClientNames", []),
    getStorage("signalDockClientNamesSucceeded", false),
    getStorage("signalDockClientNamesError", "")
  ]);

  if (!forceRefresh && cachedSuccess === true && Array.isArray(cachedNames)) {
    console.log(`[SignalDock] Using ${cachedNames.length} names fetched by the extension popup`);
    return { success: true, names: cachedNames, error: "", usingStaleCache: false };
  }

  if (!forceRefresh && Array.isArray(cachedNames) && cachedNames.length > 0) {
    console.warn(
      `[SignalDock] Live validation is unavailable; using ${cachedNames.length} cached client names`,
      cachedError || "Last refresh failed"
    );
    return {
      success: true,
      names: cachedNames,
      error: "",
      usingStaleCache: true
    };
  }

  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: "GET_SIGNALDOCK_CLIENT_NAMES" }, (response) => {
      if (chrome.runtime.lastError) {
        const backgroundError = chrome.runtime.lastError.message;
        const error = cachedError
          ? `Popup fetch failed: ${cachedError}; background fallback failed: ${backgroundError}`
          : `Background fallback failed: ${backgroundError}`;
        console.warn("[SignalDock]", error);
        setStorage({
          signalDockClientNamesSucceeded: false,
          signalDockClientNamesError: error,
          signalDockClientNamesCheckedAt: new Date().toISOString(),
          clientNameCheckSucceeded: false,
          clientNameCheckError: error,
          clientNameCheckedAt: new Date().toISOString()
        }).then(() => resolve({ success: false, names: [], error }));
        return;
      }

      if (!response || response.success !== true || !Array.isArray(response.names)) {
        const error = response && response.error ? response.error : "Invalid SignalDock response";
        console.warn("[SignalDock] Background fallback failed:", error);
        setStorage({
          signalDockClientNamesSucceeded: false,
          signalDockClientNamesError: error,
          signalDockClientNamesCheckedAt: new Date().toISOString(),
          clientNameCheckSucceeded: false,
          clientNameCheckError: error,
          clientNameCheckedAt: new Date().toISOString()
        }).then(() => resolve({ success: false, names: [], error }));
        return;
      }

      setStorage({
        signalDockClientNames: response.names,
        signalDockClientNamesSucceeded: true,
        signalDockClientNamesError: "",
        signalDockClientNamesCheckedAt: new Date().toISOString()
      }).then(() => {
        console.log(`[SignalDock] Background fallback loaded ${response.names.length} names`);
        flushPendingSignalDockClients()
          .catch((error) => console.warn("[SignalDock] Pending client uploads will retry later:", error))
          .finally(() => resolve({ success: true, names: response.names, error: "" }));
      });
    });
  });
}

async function getCachedSellerCatalog(expectedSellerCount = null, currentCategoryName = "") {
  const [totalValue, sellerNamesValue, sellerDataValue, checkSucceeded, cachedCategoryName, newSellersValue] = await Promise.all([
    getStorage("totalSellers", 0),
    getStorage("sellerNames", []),
    getStorage("sellerData", []),
    getStorage("clientNameCheckSucceeded", false),
    getStorage("sellerCatalogCategoryName", ""),
    getStorage("newSellers", 0)
  ]);

  const totalSellers = Number(totalValue);
  const sellerNames = Array.isArray(sellerNamesValue) ? sellerNamesValue : [];
  const sellerData = Array.isArray(sellerDataValue) ? sellerDataValue : [];
  const hasCompleteNames = (
    Number.isInteger(totalSellers) &&
    totalSellers > 0 &&
    sellerNames.length === totalSellers &&
    sellerData.length === totalSellers &&
    sellerNames.every((seller) => (
      seller &&
      String(seller.unique_id || "").trim() &&
      !isMissingBusinessName(seller.seller_name)
    ))
  );
  const countMatches = expectedSellerCount === null || totalSellers === expectedSellerCount;
  const categoryMatches = (
    !currentCategoryName ||
    normalizeSellerName(currentCategoryName) === normalizeSellerName(cachedCategoryName)
  );
  const valid = hasCompleteNames && countMatches && categoryMatches;

  return {
    valid,
    totalSellers,
    sellerNames,
    sellerData,
    newSellerCount: Number(newSellersValue) || 0,
    clientNameCheckSucceeded: checkSucceeded === true,
    cachedCategoryName: String(cachedCategoryName || "")
  };
}

function getSellerBusinessName(input, sellerId) {
  const candidates = [];

  // Target renders the seller's display name in a sibling span inside the
  // checkbox row, for example: styles_labelValue__FOIEK. The suffix changes,
  // so match the stable class prefix instead of the complete class name.
  const sellerRow = input.closest('div[class*="styles_col__"]');
  const rowLabelValue = sellerRow && sellerRow.querySelector(
    'span[class*="styles_labelValue__"]'
  );
  if (rowLabelValue) candidates.push(rowLabelValue.textContent);

  if (input.labels) {
    for (const label of input.labels) {
      const labelValue = label.querySelector('span[class*="styles_labelValue__"]');
      if (labelValue) candidates.push(labelValue.textContent);
      candidates.push(label.textContent);
    }
  }

  const closestLabel = input.closest("label");
  if (closestLabel) candidates.push(closestLabel.textContent);

  candidates.push(
    input.getAttribute("aria-label"),
    input.getAttribute("data-label"),
    input.value,
    input.nextElementSibling && input.nextElementSibling.textContent
  );

  for (const candidate of candidates) {
    const name = String(candidate || "").replace(/\s+/g, " ").trim();
    const normalized = name.toLowerCase();
    if (
      name &&
      normalized !== "on" &&
      normalized !== "true" &&
      normalized !== "false" &&
      !normalized.includes("include out of stock")
    ) {
      return name;
    }
  }

  try {
    return decodeURIComponent(sellerId).replace(/[_-]+/g, " ").trim() || sellerId;
  } catch {
    return sellerId;
  }
}

function startSellerDiscovery() {
  if (isAutomationRunning) return Promise.resolve(false);
  if (sellerDiscoveryPromise) return sellerDiscoveryPromise;

  const discoveryGeneration = automationGeneration;
  sellerDiscoveryPromise = discoverSellerNames(discoveryGeneration)
    .catch((error) => {
      console.error("Failed to discover seller names:", error);
      return false;
    })
    .finally(() => {
      sellerDiscoveryPromise = null;
    });

  return sellerDiscoveryPromise;
}

async function discoverSellerNames(discoveryGeneration) {
  if (shouldStopAutomation || discoveryGeneration !== automationGeneration) return false;

  const categoryName = extractCategoryName();
  const cachedCatalog = await getCachedSellerCatalog(null, categoryName || "");
  if (shouldStopAutomation || discoveryGeneration !== automationGeneration) return false;
  if (cachedCatalog.valid) {
    console.log(`Using cached seller catalog (${cachedCatalog.totalSellers} sellers); modal scan skipped`);
    const refreshedStatus = await refreshCachedSignalDockStatuses(cachedCatalog);
    if (shouldStopAutomation || discoveryGeneration !== automationGeneration) return false;
    if (!refreshedStatus.clientNameCheckSucceeded) {
      console.warn("[SignalDock] Cached seller status refresh failed:", refreshedStatus.clientNameCheckError);
    }
    return true;
  }

  const breadcrumbSteps = extractBreadcrumbSteps();
  if (categoryName) {
    await saveCategoryData(categoryName, breadcrumbSteps);
  }

  const opened = await openFiltersAndSellerPanel();
  if (shouldStopAutomation || discoveryGeneration !== automationGeneration) return false;
  if (!opened) {
    console.error("Could not open the seller panel for name discovery");
    return false;
  }

  try {
    await sleep(500);
    const checkboxes = document.querySelectorAll('input[data-test^="facet-checkbox-"]');
    const { sellerCheckboxes, skipped, disabled } = filterSellerCheckboxes(checkboxes);

    console.log(`Discovered ${sellerCheckboxes.length} valid seller names`);
    console.log(`Skipped out-of-stock option: ${skipped}; disabled: ${disabled}`);
    const initialization = await initializeSellerRows(sellerCheckboxes);
    return initialization.clientNameCheckSucceeded;
  } finally {
    const modal = getModal();
    const closeButton = modal && (
      modal.querySelector('[data-test="modal-close-button"]') ||
      modal.querySelector('button[aria-label="close"], button[aria-label="Close"]')
    );
    if (closeButton) scrollToAndClick(closeButton);
  }
}

function filterSellerCheckboxes(inputs) {
  let skipped = 0;
  let disabled = 0;

  const sellerCheckboxes = [...inputs].filter((input) => {
    const dataTest = input.getAttribute("data-test") || "";
    const inputValue = (input.value || "").toLowerCase();

    if (
      dataTest === "facet-checkbox-include_out_of_stock" ||
      dataTest.includes("out_of_stock") ||
      inputValue.includes("out of stock")
    ) {
      skipped++;
      return false;
    }

    if (input.disabled || input.getAttribute("aria-disabled") === "true") {
      disabled++;
      return false;
    }

    return true;
  });

  return { sellerCheckboxes, skipped, disabled };
}

function applySignalDockResult(sellerRows, clientCheck) {
  let newSellerCount = 0;

  if (clientCheck.success) {
    const existingClientNames = new Set(
      clientCheck.names
        .map(normalizeSellerName)
        .filter(Boolean)
    );
    const seenCurrentSellerNames = new Set();

    for (const seller of sellerRows) {
      const normalizedName = normalizeSellerName(seller.seller_name);
      const isExistingClient = existingClientNames.has(normalizedName);
      const isDuplicateSeller = seenCurrentSellerNames.has(normalizedName);
      seenCurrentSellerNames.add(normalizedName);

      seller.is_existing_client = isExistingClient;
      seller.is_duplicate_seller = isDuplicateSeller;
      seller.is_new_seller = !isExistingClient && !isDuplicateSeller;
      seller.status = (
        isExistingClient ||
        isDuplicateSeller ||
        hasCompletedSoldByLookup(seller) ||
        hasFoundSellerEmail(seller)
      ) ? "Found" : "Not Found";

      if (seller.is_new_seller) newSellerCount++;
    }

    console.log(`SignalDock matched ${sellerRows.length - newSellerCount} existing/duplicate sellers`);
    console.log(`SignalDock found ${newSellerCount} unique new sellers`);
  } else {
    for (const seller of sellerRows) {
      seller.status = hasFoundSellerStatus(seller) ? "Found" : "Not Found";
      seller.is_new_seller = seller.is_new_seller === true;
    }
    newSellerCount = sellerRows.filter((seller) => seller.is_new_seller).length;
    console.warn(`SignalDock client-name check unavailable: ${clientCheck.error}`);
  }

  return newSellerCount;
}

async function refreshCachedSignalDockStatuses(cachedCatalog, syncedClientCheck = null) {
  const sellerRows = cachedCatalog.sellerData.map((seller) => ({ ...seller }));
  const clientCheck = syncedClientCheck || await getSignalDockClientNames();
  const newSellerCount = applySignalDockResult(sellerRows, clientCheck);

  await setStorage({
    sellerNames: sellerRows.map((seller) => ({
      id: seller.id,
      unique_id: seller.unique_id,
      seller_name: seller.seller_name,
      status: seller.status,
      is_existing_client: seller.is_existing_client,
      is_duplicate_seller: seller.is_duplicate_seller,
      is_new_seller: seller.is_new_seller
    })),
    sellerData: sellerRows,
    newSellers: newSellerCount,
    clientNameCheckSucceeded: clientCheck.success,
    clientNameCheckError: clientCheck.error || "",
    clientNameCheckedAt: new Date().toISOString()
  });

  return {
    sellerRows,
    clientNameCheckSucceeded: clientCheck.success,
    clientNameCheckError: clientCheck.error || "",
    newSellerCount
  };
}

async function initializeSellerRows(sellerCheckboxes) {
  const storedData = await getStorage("sellerData", []);
  const existingData = Array.isArray(storedData) ? storedData : [];
  const existingById = new Map(
    existingData
      .filter((seller) => seller && seller.unique_id)
      .map((seller) => [String(seller.unique_id), seller])
  );

  const sellerRows = sellerCheckboxes.map((input, index) => {
    const dataTest = input.getAttribute("data-test") || "";
    const sellerId = dataTest.replace("facet-checkbox-", "");
    const existingSeller = existingById.get(sellerId) || {};
    const checkboxName = getSellerBusinessName(input, sellerId);
    const sellerName = checkboxName || existingSeller.seller_name || "Not found";
    const businessName = isMissingBusinessName(existingSeller.business_name)
      ? sellerName
      : existingSeller.business_name;

    return {
      seller_name: sellerName,
      business_name: businessName || "Not found",
      email: "Not found",
      headquarters: "Not found",
      mobile_number: "Not found",
      store_link: "Not found",
      error_reason: "",
      status: "Not Found",
      is_existing_client: false,
      is_duplicate_seller: false,
      is_new_seller: false,
      ...existingSeller,
      id: index + 1,
      unique_id: sellerId,
      seller_name: sellerName,
      business_name: businessName || "Not found"
    };
  });

  const clientCheck = await getSignalDockClientNames();
  const newSellerCount = applySignalDockResult(sellerRows, clientCheck);

  const sellerCatalogCategoryName = extractCategoryName() || await getStorage("categoryName", "");

  await setStorage({
    sellerNames: sellerRows.map((seller) => ({
      id: seller.id,
      unique_id: seller.unique_id,
      seller_name: seller.seller_name,
      status: seller.status,
      is_existing_client: seller.is_existing_client,
      is_duplicate_seller: seller.is_duplicate_seller,
      is_new_seller: seller.is_new_seller
    })),
    sellerData: sellerRows,
    totalSellers: sellerRows.length,
    newSellers: newSellerCount,
    clientNameCheckSucceeded: clientCheck.success,
    clientNameCheckError: clientCheck.error || "",
    clientNameCheckedAt: new Date().toISOString(),
    sellerCatalogCategoryName
  });
  console.log(`Saved ${sellerRows.length} seller business names to the table data`);

  return {
    sellerRows,
    clientNameCheckSucceeded: clientCheck.success,
    clientNameCheckError: clientCheck.error || "",
    newSellerCount
  };
}

async function saveSellerData(sellerData) {
  const [storedData, storedSellerNames] = await Promise.all([
    getStorage("sellerData", []),
    getStorage("sellerNames", [])
  ]);
  const data = Array.isArray(storedData) ? storedData : [];
  const sellerNames = Array.isArray(storedSellerNames) ? storedSellerNames : [];
  const defaults = {
    seller_name: "Not found",
    business_name: "Not found",
    email: "Not found",
    headquarters: "Not found",
    mobile_number: "Not found",
    store_link: "Not found",
    error_reason: "",
    status: "Not Found",
    is_existing_client: false,
    is_duplicate_seller: false,
    is_new_seller: false
  };
  const existingIndex = sellerData.unique_id
    ? data.findIndex((seller) => String(seller.unique_id) === String(sellerData.unique_id))
    : -1;
  const previousEmail = existingIndex >= 0
    ? String(data[existingIndex].email || "").trim().toLowerCase()
    : "";

  let savedSeller;
  if (existingIndex >= 0) {
    const existingSeller = data[existingIndex];
    const updatedSeller = { ...defaults, ...existingSeller, ...sellerData };

    if (
      isMissingBusinessName(sellerData.business_name) &&
      !isMissingBusinessName(existingSeller.business_name)
    ) {
      updatedSeller.business_name = existingSeller.business_name;
    }

    updatedSeller.status = hasFoundSellerStatus(updatedSeller) ? "Found" : "Not Found";
    data[existingIndex] = updatedSeller;
    savedSeller = updatedSeller;
  } else {
    const newSeller = { ...defaults, ...sellerData };
    newSeller.status = hasFoundSellerStatus(newSeller) ? "Found" : "Not Found";
    data.push(newSeller);
    savedSeller = newSeller;
  }

  const synchronizedSellerNames = sellerNames.map((seller) => (
    String(seller.unique_id || "") === String(savedSeller.unique_id || "")
      ? { ...seller, status: savedSeller.status }
      : seller
  ));

  await setStorage({ sellerData: data, sellerNames: synchronizedSellerNames });

  const savedEmail = String(savedSeller.email || "").trim();
  if (isUsableSellerEmail(savedEmail) && savedEmail.toLowerCase() !== previousEmail) {
    const response = await createSignalDockClient(savedSeller);
    if (response.success) {
      const pendingValue = await getStorage("signalDockPendingClients", []);
      const pending = Array.isArray(pendingValue) ? pendingValue : [];
      await setStorage({
        signalDockPendingClients: pending.filter((client) => (
          String(client.email || "").trim().toLowerCase() !== savedEmail.toLowerCase()
        ))
      });
      console.log(`[SignalDock] Added seller email to shared client database: ${savedEmail}`);
    } else {
      await queueSignalDockClient(savedSeller);
      console.error(`[SignalDock] Could not add ${savedEmail} to shared client database: ${response.error}`);
    }
  }
}

async function logSellerDataAsJSON() {
  const data = await getStorage("sellerData", []);
  console.log("📊 SELLER DATA (JSON):");
  console.log(JSON.stringify(data, null, 2));
  return data;
}

// --------------------
// DOM helpers
// --------------------
function waitForSelector(selector, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) {
        observer.disconnect();
        resolve(found);
      }
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for ${selector}`));
    }, timeout);
  });
}

async function waitForFirstProductLink(timeout = 30000, pollInterval = 500) {
  console.log(`Waiting up to ${Math.round(timeout / 1000)} seconds for a product...`);
  const start = Date.now();
  let lastProgressReport = 0;

  while (Date.now() - start < timeout) {
    if (shouldStopAutomation) return null;

    if (Date.now() - lastProgressReport >= 10000) {
      reportAutomationProgress("waiting-for-filtered-product");
      lastProgressReport = Date.now();
    }

    const productLink = document.querySelector('a[data-test="@web/ProductCard/title"]');
    if (productLink && productLink.href) {
      console.log(`Product found after ${Math.ceil((Date.now() - start) / 1000)} second(s)`);
      return productLink;
    }

    await sleep(pollInterval);
  }

  console.warn(`No product appeared within ${Math.round(timeout / 1000)} seconds`);
  return null;
}

// --------------------
// Uncheck all checked seller checkboxes
// --------------------
async function uncheckAllSellers() {
  const checkedBoxes = document.querySelectorAll('input[data-test^="facet-checkbox-"]:checked');
  let uncheckedCount = 0;
  for (const cb of checkedBoxes) {
    const cbId = (cb.getAttribute("data-test") || "").replace("facet-checkbox-", "");
    const cbValue = (cb.value || "").toLowerCase();
    if (cbId === "include_out_of_stock" || cbId.includes("out_of_stock") || cbValue.includes("out of stock")) continue;
    console.log(`🔄 Unchecking: ${cbId}`);
    scrollToAndClick(cb);
    uncheckedCount++;
    await sleep(300);
  }
  if (uncheckedCount > 0) {
    console.log(`✅ Unchecked ${uncheckedCount} seller(s)`);
  }
}

// --------------------
// Page State Verification
// --------------------
async function verifyModalOpen(timeout = 5000) {
  console.log("🔍 Verifying modal is open...");
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const modal = document.querySelector('div[role="dialog"][aria-modal="true"]');
    if (modal) {
      console.log("✅ Modal confirmed open");
      return true;
    }
    await sleep(200);
  }
  console.warn("❌ Modal not detected!");
  return false;
}

async function verifySellerPanelOpen(timeout = 5000) {
  console.log("🔍 Verifying seller panel is open...");
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const checkboxes = document.querySelectorAll('input[data-test^="facet-checkbox-"]');
    if (checkboxes.length > 1) {
      console.log(`✅ Seller panel confirmed open (${checkboxes.length} checkboxes found)`);
      return true;
    }
    await sleep(200);
  }
  console.warn("❌ Seller panel not detected!");
  return false;
}

async function verifyProductListingPage(timeout = 5000) {
  console.log("🔍 Verifying we're on product listing page...");
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const productCards = document.querySelectorAll('[data-test="@web/site-top-of-funnel/ProductCardWrapper"]');
    if (productCards.length > 0) {
      console.log(`✅ Product listing confirmed (${productCards.length} products found)`);
      return true;
    }
    await sleep(200);
  }
  console.warn("❌ Product listing page not detected!");
  return false;
}

async function verifyProductPage(timeout = 5000) {
  console.log("🔍 Verifying we're on product detail page...");
  const start = Date.now();
  while (Date.now() - start < timeout) {
    // Check for product-specific elements
    const addToCart = document.querySelector('[data-test="shippingAddToCartButton"]');
    const productTitle = document.querySelector('h1');
    if (addToCart || (productTitle && productTitle.textContent.length > 0)) {
      console.log("✅ Product page confirmed");
      return true;
    }
    await sleep(200);
  }
  console.warn("❌ Product page not detected!");
  return false;
}

async function verifySellerPage(timeout = 5000) {
  console.log("🔍 Verifying we're on seller page...");
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const contactTab = document.querySelector('[data-test="tabContact"]');
    if (contactTab) {
      console.log("✅ Seller page confirmed");
      return true;
    }
    await sleep(200);
  }
  console.warn("❌ Seller page not detected!");
  return false;
}

async function verifyContactTabOpen(timeout = 5000) {
  console.log("🔍 Verifying contact tab is open...");
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const contactContent = document.querySelector('[data-test="tab-tabContent-tab-Contact"]');
    if (contactContent && contactContent.textContent.length > 0) {
      console.log("✅ Contact tab confirmed open");
      return true;
    }
    await sleep(200);
  }
  console.warn("❌ Contact tab not detected!");
  return false;
}

function findElementByText(text, tagFilter = "a,button,span,div") {
  const candidates = document.querySelectorAll(tagFilter);
  const target = text.trim().toLowerCase();
  for (const el of candidates) {
    if (el.textContent && el.textContent.trim().toLowerCase().includes(target)) {
      return el;
    }
  }
  return null;
}

function clickElement(element, description = "element") {
  if (!element) {
    console.warn(`❌ Cannot click ${description} - element is null`);
    return false;
  }

  console.log(`🖱️  Preparing to click: ${description}`);
  console.log(`   Element type: ${element.tagName}`);
  console.log(`   Element text: ${element.textContent?.substring(0, 50)}`);
  console.log(`   Element visible: ${element.offsetParent !== null}`);

  scrollToAndClick(element);
  console.log(`✅ Clicked: ${description}`);
  return true;
}

function getModal() {
  return document.querySelector('div[role="dialog"][aria-modal="true"]');
}

function parseContactText(text) {
  const emailMatch = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
  const phoneMatch = text.match(/(?:\+?1[\s.-]*)?(?:\(\d{3}\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4}\b/);
  const businessNameMatch = text.match(/Legal Business Name:\s*([^H]+?)(?=Headquarters:|$)/);
  const headquartersMatch = text.match(/Headquarters:(.+?)(?:Contact|Partner Information|$)/s);

  const businessName = businessNameMatch ? businessNameMatch[1].trim() : "Not found";
  const email = emailMatch ? emailMatch[0] : "Not found";
  const mobileNumber = phoneMatch ? phoneMatch[0].trim() : "Not found";
  let headquarters = "Not found";
  if (headquartersMatch) {
    headquarters = headquartersMatch[1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(", ");
  }

  return { businessName, email, headquarters, mobileNumber };
}

// --------------------
// New tab helpers
// --------------------
function requestProductSellerDataOnce(productUrl, sellerId, sellerIndex, timeout = 250000) {
  return new Promise((resolve) => {
    let settled = false;
    const clientRequestId = `category-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const finish = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      pendingProductRequests.delete(clientRequestId);
      resolve(response);
    };

    const timeoutId = setTimeout(() => {
      finish({
        success: false,
        phase: "content-request-timeout",
        error: `Background product workflow did not respond within ${timeout} ms`
      });
    }, timeout);

    pendingProductRequests.set(clientRequestId, { resolve: finish });

    chrome.runtime.sendMessage({
      action: "PROCESS_TARGET_PRODUCT_V9",
      clientRequestId,
      productUrl,
      sellerId,
      sellerIndex
    }, (response) => {
      // Read lastError even if the direct result already settled this request.
      const runtimeError = chrome.runtime.lastError;
      if (settled) return;

      if (runtimeError) {
        // The direct PRODUCT_WORKFLOW_RESULT_V11 message remains available even
        // if this long-lived response channel is closed by Chrome.
        console.warn("Primary product response channel closed; waiting for direct result:", runtimeError.message);
        return;
      }

      console.log("Product workflow response received from background", {
        success: Boolean(response && response.success),
        phase: response && response.phase ? response.phase : "complete",
        requestId: response && response.requestId ? response.requestId : "unknown-request"
      });
      finish(response || {
        success: false,
        phase: "background-response",
        error: "Background product workflow returned no response"
      });
    });
  });
}

async function requestProductSellerData(productUrl, sellerId, sellerIndex, maxAttempts = 3) {
  let lastResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    reportAutomationProgress(`product-workflow-attempt-${attempt}`);
    console.log(`Product workflow attempt ${attempt}/${maxAttempts} for seller ${sellerId}`);
    lastResult = await requestProductSellerDataOnce(productUrl, sellerId, sellerIndex);

    if (lastResult && lastResult.success === true) return lastResult;
    if (attempt < maxAttempts) {
      const phase = lastResult && lastResult.phase ? lastResult.phase : "unknown-phase";
      console.warn(`Product workflow attempt ${attempt} failed during ${phase}; retrying...`);
      await sleep(3000);
    }
  }

  return lastResult || {
    success: false,
    phase: "product-retries-exhausted",
    error: `Product workflow failed after ${maxAttempts} attempts`
  };
}

async function collectSellerFromProductUrl(productUrl, sellerId, sellerIndex) {
  console.log(`🔗 Opening product in new tab: ${productUrl}`);
  console.log("⏳ Background is creating and monitoring the product tab...");

  const productResult = await requestProductSellerData(productUrl, sellerId, sellerIndex);
  if (productResult && productResult.success && productResult.sellerData) {
    console.log(`✅ Product workflow completed (${productResult.requestId || "no request ID"})`);
    return productResult.sellerData;
  }

  const failurePhase = productResult && productResult.phase
    ? productResult.phase
    : "unknown-phase";
  const failureReason = productResult && productResult.error
    ? productResult.error
    : "Unknown product workflow error";
  console.error(`❌ Product workflow failed during ${failurePhase}: ${failureReason}`);
  return {
    id: sellerIndex,
    unique_id: sellerId,
    email: `Not found - Product ${failurePhase}`,
    store_link: "Not found",
    error_reason: failureReason
  };
}

async function saveApplyResumeCheckpoint(sellerId, sellerIndex, sellerName) {
  await setStorage({
    automationResumeState: {
      active: true,
      stage: "after-seller-apply",
      sellerId: String(sellerId || ""),
      sellerIndex: Number(sellerIndex) || 0,
      sellerName: String(sellerName || sellerId || "Unknown seller"),
      categoryPathname: window.location.pathname,
      createdAt: Date.now()
    }
  });
  console.log(`💾 Navigation checkpoint saved for seller ${sellerName} (${sellerId})`);
}

async function clearApplyResumeCheckpoint(sellerId = "") {
  const checkpoint = await getStorage("automationResumeState", null);
  if (
    checkpoint &&
    checkpoint.active &&
    sellerId &&
    String(checkpoint.sellerId || "") !== String(sellerId)
  ) {
    return;
  }
  await setStorage({ automationResumeState: null });
}

async function markSellerAttemptedForCurrentRun(sellerId) {
  const storedIds = await getStorage("automationAttemptedSellerIds", []);
  const attemptedIds = new Set(
    (Array.isArray(storedIds) ? storedIds : []).map((value) => String(value))
  );
  attemptedIds.add(String(sellerId));
  await setStorage({ automationAttemptedSellerIds: [...attemptedIds] });
}

async function resumeAutomationFromCheckpoint() {
  const checkpoint = await getStorage("automationResumeState", null);
  if (!checkpoint || checkpoint.active !== true || checkpoint.stage !== "after-seller-apply") return;
  if (String(checkpoint.categoryPathname || "") !== window.location.pathname) return;

  const checkpointAge = Date.now() - Number(checkpoint.createdAt || 0);
  if (!Number.isFinite(checkpointAge) || checkpointAge > 15 * 60 * 1000) {
    console.warn("Discarding an expired automation navigation checkpoint");
    await clearApplyResumeCheckpoint(checkpoint.sellerId);
    return;
  }
  if (isAutomationRunning) return;

  isAutomationRunning = true;
  shouldStopAutomation = false;
  const resumeGeneration = ++automationGeneration;
  startAutomationHeartbeat("resume-after-seller-apply");
  let continueRemainingSellers = false;

  try {
    console.log(
      `🔄 Resuming after Target navigation for ${checkpoint.sellerName} (${checkpoint.sellerId})`
    );
    await sleep(1500);
    if (resumeGeneration !== automationGeneration || shouldStopAutomation) return;

    const firstProductLink = await waitForFirstProductLink(30000);
    if (resumeGeneration !== automationGeneration || shouldStopAutomation) return;
    let finalSellerData;
    if (!firstProductLink) {
      console.warn(`No product appeared after navigation for ${checkpoint.sellerName}`);
      finalSellerData = {
        id: checkpoint.sellerIndex,
        unique_id: checkpoint.sellerId,
        email: "Not found - No products after navigation",
        store_link: "Not found",
        error_reason: "No product appeared within 30 seconds after applying seller filter"
      };
    } else {
      finalSellerData = await collectSellerFromProductUrl(
        firstProductLink.href,
        checkpoint.sellerId,
        checkpoint.sellerIndex
      );
    }

    if (resumeGeneration !== automationGeneration || shouldStopAutomation) return;

    await saveSellerData(finalSellerData);
    console.log(`✅ Resumed seller completed: ${checkpoint.sellerName}`);
    continueRemainingSellers = true;
  } catch (error) {
    console.error("Resume after seller-filter navigation failed:", error);
    await saveSellerData({
      id: checkpoint.sellerIndex,
      unique_id: checkpoint.sellerId,
      email: "Not found - Resume error",
      store_link: "Not found",
      error_reason: error && error.message ? error.message : String(error)
    });
    continueRemainingSellers = true;
  } finally {
    await clearApplyResumeCheckpoint(checkpoint.sellerId);
    stopAutomationHeartbeat();
    isAutomationRunning = false;
  }

  if (continueRemainingSellers && !shouldStopAutomation) {
    console.log("🔄 Restarting the seller queue after navigation resume...");
    await sleep(1500);
    await runAutomation();
  }
}

async function bootstrapAutomationContinuation() {
  const checkpoint = await getStorage("automationResumeState", null);
  if (
    checkpoint &&
    checkpoint.active === true &&
    checkpoint.stage === "after-seller-apply" &&
    String(checkpoint.categoryPathname || "") === window.location.pathname
  ) {
    await resumeAutomationFromCheckpoint();
    return;
  }

  const watchdog = await getStorage("automationWatchdog", null);
  if (
    !watchdog ||
    watchdog.desiredRunning !== true ||
    String(watchdog.categoryPathname || "") !== window.location.pathname ||
    isAutomationRunning
  ) {
    return;
  }

  console.warn("🔁 Watchdog requested a full automation restart from the beginning", {
    previousStage: watchdog.lastStage || "unknown",
    restartCount: Number(watchdog.restartCount || 0)
  });
  if (watchdog.forceRestart === true) {
    await setStorage({
      automationAttemptedSellerIds: [],
      automationResumeState: null
    });
  }
  await updateAutomationWatchdog(true, "automatic-restart", false);
  await runAutomation();
}

function findInCurrentPage(text, tagFilter = "a,button,span,div") {
  const candidates = document.querySelectorAll(tagFilter);
  const target = text.trim().toLowerCase();
  for (const el of candidates) {
    if (el.textContent && el.textContent.trim().toLowerCase().includes(target)) {
      return el;
    }
  }
  return null;
}

function findContactTab() {
  return (
    document.querySelector('[data-test="tabContact"]') ||
    document.querySelector('#tab-Contact') ||
    document.querySelector('button[aria-controls="tabContent-tab-Contact"]') ||
    findInCurrentPage("Contact", "button")
  );
}

async function waitForContactTab(timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = findContactTab();
    if (tab) return tab;
    await sleep(500);
  }
  return null;
}

async function findSoldByLinkWithRetries(attempts = 5, delayMs = 2000, requestId = "unknown-request") {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`[Product ${requestId}] [${attempt}/${attempts}] Looking for "Sold & shipped by"...`);

    let soldByLink =
      findInCurrentPage("Sold & shipped by", "a") ||
      findInCurrentPage("Sold & shipped by", "button") ||
      findInCurrentPage("Sold & shipped by") ||
      findInCurrentPage("Sold and shipped by");

    if (soldByLink) return soldByLink;

    if (attempt < attempts) {
      console.warn(`[Product ${requestId}] 'Sold & shipped by' not found yet, waiting...`);
      await sleep(delayMs);
    }
  }

  return null;
}

async function getContactDataWithRetries(attempts = 3, delayMs = 8000, requestId = "unknown-request") {
  let lastContactText = null;
  let lastParsed = null;
  let lastReason = "Contact tab not found";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`[Product ${requestId}] [${attempt}/${attempts}] Checking contact tab/content...`);

    const contactTab = await waitForContactTab(5000);
    if (contactTab) {
      try {
        scrollToAndClick(contactTab);
      } catch (error) {
        lastReason = error && error.message ? error.message : "Contact tab click error";
        console.warn("Contact tab click attempt failed:", error);
        if (attempt < attempts) await sleep(delayMs);
        continue;
      }
      await sleep(2000);

      const contactContentEl = document.querySelector('[data-test="tab-tabContent-tab-Contact"]');
      if (contactContentEl && contactContentEl.textContent && contactContentEl.textContent.trim().length > 0) {
        lastContactText = contactContentEl.textContent;
        lastParsed = parseContactText(lastContactText);

        if (lastParsed.email !== "Not found") {
          return {
            parsed: lastParsed,
            contactText: lastContactText,
            success: true,
            attemptsUsed: attempt,
            errorReason: ""
          };
        }

        lastReason = "Email not found";

        console.warn("⚠️ Email not found yet, waiting for more data...");
      } else {
        lastReason = "Contact content empty";
        console.warn("⚠️ Contact content empty, waiting...");
      }
    } else {
      lastReason = "Contact tab not found";
      console.warn("⚠️ Contact tab not found yet.");
    }

    if (attempt < attempts) await sleep(delayMs);
  }

  return {
    parsed: lastParsed || {
      businessName: "Not found",
      email: "Not found",
      headquarters: "Not found",
      mobileNumber: "Not found"
    },
    contactText: lastContactText,
    success: false,
    attemptsUsed: attempts,
    errorReason: `${lastReason} after trying ${attempts} times`
  };
}

async function discoverSellerFromCurrentProduct(sellerId, sellerIndex, requestId = "unknown-request") {
  console.log(`[Product ${requestId}] Product page URL: ${window.location.href}`);
  console.log(`[Product ${requestId}] Searching for 'Sold & shipped by' link...`);

  await sleep(500);
  const soldByLink = await findSoldByLinkWithRetries(5, 2000, requestId);

  if (!soldByLink) {
    console.warn("⚠️ 'Sold & shipped by' not found in new tab");
    return {
      retry: false,
      sellerData: {
        id: sellerIndex,
        unique_id: sellerId,
        email: "Sold & shipped by not found",
        store_link: "Not found",
        error_reason: "Sold & shipped by not found",
        status: "Found"
      }
    };
  }

  console.log(`[Product ${requestId}] Found 'Sold & shipped by' link`, {
    tagName: soldByLink.tagName,
    href: soldByLink.href || "",
    text: (soldByLink.textContent || "").trim().slice(0, 200)
  });

  const sellerAnchor = soldByLink.closest("a[href]");
  if (sellerAnchor && sellerAnchor.href) {
    console.log(`[Product ${requestId}] Seller destination discovered: ${sellerAnchor.href}`);
    return { sellerUrl: sellerAnchor.href };
  }

  // Target currently exposes an anchor, but retain support for a button/modal UI.
  console.log(`[Product ${requestId}] Seller element has no URL; using in-page click fallback...`);

  scrollToAndClick(soldByLink);
  await sleep(1500);

  return extractSellerContactFromCurrentPage(sellerId, sellerIndex, requestId);
}

async function extractSellerContactFromCurrentPage(sellerId, sellerIndex, requestId = "unknown-request") {
  const sellerPageUrl = window.location.href;
  console.log(`[Product ${requestId}] Extracting contact data from: ${sellerPageUrl}`);

  const contactData = await getContactDataWithRetries(3, 8000, requestId);
  if (contactData && contactData.success) {
    const parsed = contactData.parsed;

    console.log(`📧 Extracted - Business: ${parsed.businessName}, Email: ${parsed.email}`);
    console.log(`🔗 Store Link: ${sellerPageUrl}`);

    return {
      retry: false,
      sellerData: {
        id: sellerIndex,
        unique_id: sellerId,
        business_name: parsed.businessName,
        email: parsed.email,
        headquarters: parsed.headquarters,
        mobile_number: parsed.mobileNumber,
        store_link: sellerPageUrl
      }
    };
  }

  console.warn("⚠️ Contact tab/content not available after waiting");
  const parsed = contactData ? contactData.parsed : {
    businessName: "Not found",
    headquarters: "Not found",
    mobileNumber: "Not found"
  };
  const errorReason = contactData ? contactData.errorReason : "Contact data not found after trying 3 times";

  return {
    retry: false,
    sellerData: {
      id: sellerIndex,
      unique_id: sellerId,
      business_name: parsed.businessName,
      email: "Not found trying 3 times",
      headquarters: parsed.headquarters,
      mobile_number: parsed.mobileNumber,
      store_link: sellerPageUrl,
      error_reason: errorReason
    }
  };
}

// --------------------
// Seller loop
// --------------------
async function collectSellerEmails() {
  console.log("⏳ Waiting for seller panel to load...");

  // Wait for seller checkboxes to appear (not just the modal) - retry aggressively
  let tempCheckboxes = null;
  let attempts = 0;
  const maxLoadAttempts = 20; // Increased from 10
  while (attempts < maxLoadAttempts) {
    if (shouldStopAutomation) return;
    await sleep(500);
    tempCheckboxes = document.querySelectorAll('input[data-test^="facet-checkbox-"]');
    console.log(`🔍 Attempt ${attempts + 1}: Found ${tempCheckboxes.length} seller checkboxes`);

    if (tempCheckboxes.length > 1) { // More than just "Include out of stock"
      console.log("✅ Seller checkboxes loaded!");
      break;
    }
    attempts++;
  }

  if (tempCheckboxes.length <= 1) {
    console.warn("⚠️ Seller checkboxes not found; closing and reopening the panel...");
    const closeButton = document.querySelector('[data-test="modal-close-button"]') ||
      document.querySelector('button[aria-label="close"], button[aria-label="Close"]');
    if (closeButton) scrollToAndClick(closeButton);
    await sleep(1500);
    const retryOpen = await openFiltersAndSellerPanel();
    if (!retryOpen) {
      console.error("❌ Seller checkboxes still not found after bounded panel retries.");
      await requestAutomationRestart("seller checkboxes did not load");
      return;
    }
    await sleep(1000);
    tempCheckboxes = document.querySelectorAll('input[data-test^="facet-checkbox-"]');
    if (tempCheckboxes.length <= 1) {
      console.error("❌ No seller checkboxes found after reopening the panel.");
      await requestAutomationRestart("seller checkbox panel remained empty");
      return;
    }
  }

  await sleep(500); // Extra wait for stability

  console.log("🔍 Filtering seller checkboxes...");

  // Filter out "Include out of stock" and disabled checkboxes
  const { sellerCheckboxes, skipped, disabled } = filterSellerCheckboxes(tempCheckboxes);

  console.log(`✅ Valid sellers found: ${sellerCheckboxes.length}`);
  console.log(`   - Skipped "Include out of stock": ${skipped}`);
  console.log(`   - Skipped disabled: ${disabled}`);

  const currentCategoryName = extractCategoryName() || "";
  const cachedCatalog = await getCachedSellerCatalog(
    sellerCheckboxes.length,
    currentCategoryName
  );
  let initialization;

  if (cachedCatalog.valid) {
    console.log(`Using cached seller catalog (${cachedCatalog.totalSellers} sellers); cache write skipped`);
    initialization = {
      sellerRows: cachedCatalog.sellerData,
      clientNameCheckSucceeded: cachedCatalog.clientNameCheckSucceeded,
      clientNameCheckError: "",
      newSellerCount: cachedCatalog.newSellerCount
    };
  } else {
    // Create seller rows and run SignalDock only when the catalog cache is missing,
    // incomplete, belongs to another category, or the seller count changed.
    initialization = await initializeSellerRows(sellerCheckboxes);
  }

  if (!initialization.clientNameCheckSucceeded) {
    console.warn(
      "SignalDock could not confirm new sellers; continuing with locally incomplete sellers only"
    );
  }

  if (sellerCheckboxes.length === 0) {
    console.warn("❌ No valid seller checkboxes found.");
    await requestAutomationRestart("no valid seller checkboxes were available");
    return;
  }

  const storedSellerData = await getStorage("sellerData", []);
  const sellerById = new Map(
    (Array.isArray(storedSellerData) ? storedSellerData : [])
      .filter((seller) => seller && seller.unique_id)
      .map((seller) => [String(seller.unique_id), seller])
  );
  const storedAttemptedSellerIds = await getStorage("automationAttemptedSellerIds", []);
  const attemptedSellerIds = new Set(
    (Array.isArray(storedAttemptedSellerIds) ? storedAttemptedSellerIds : [])
      .map((sellerId) => String(sellerId))
  );
  const pendingSellerIds = new Set(
    sellerCheckboxes
      .map((input) => (input.getAttribute("data-test") || "").replace("facet-checkbox-", ""))
      .filter((sellerId) => (
        !attemptedSellerIds.has(sellerId) &&
        !hasFoundSellerStatus(sellerById.get(sellerId))
      ))
  );
  const pendingSellerCount = pendingSellerIds.size;
  let attemptedPendingCount = 0;

  console.log(`Not Found sellers queued: ${pendingSellerCount}`);

  if (pendingSellerCount === 0) {
    const incompleteSellerCount = sellerCheckboxes
      .map((input) => (input.getAttribute("data-test") || "").replace("facet-checkbox-", ""))
      .filter((sellerId) => !hasFoundSellerStatus(sellerById.get(sellerId)))
      .length;
    if (incompleteSellerCount > 0) {
      console.log(
        `All ${incompleteSellerCount} locally incomplete seller(s) were already attempted during this run.`
      );
    } else {
      console.log("All sellers already have a found email. Nothing to process.");
    }
    await finishAutomationRun("all-sellers-attempted");
    return;
  }

  for (let i = 0; i < sellerCheckboxes.length; i++) {
    const input = sellerCheckboxes[i];
    if (!input) continue;

    const dataTest = input.getAttribute("data-test") || "";
    const sellerId = dataTest.replace("facet-checkbox-", "");
    if (!pendingSellerIds.has(sellerId)) continue;
    pendingSellerIds.delete(sellerId);

    // Check if user requested stop only when a pending seller is reached.
    if (shouldStopAutomation) {
      console.log("🛑 ========================================");
      console.log("🛑 AUTOMATION STOPPED BY USER");
      console.log("🛑 ========================================");
      console.log(`📊 Attempted ${attemptedPendingCount} of ${pendingSellerCount} Not Found sellers`);
      await logSellerDataAsJSON();
      return;
    }

    attemptedPendingCount++;
    const sellerName = getSellerBusinessName(input, sellerId);
    await markSellerAttemptedForCurrentRun(sellerId);
    reportAutomationProgress(`processing-seller-${attemptedPendingCount}-of-${pendingSellerCount}`);

    try {
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`🔄 [${attemptedPendingCount}/${pendingSellerCount}] Processing Not Found seller: ${sellerName} (${sellerId})`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      // Uncheck all currently checked seller checkboxes
      await uncheckAllSellers();

      // Get the current checkbox from DOM (in case DOM changed)
      const currentCheckbox = document.querySelector(`[data-test="facet-checkbox-${sellerId}"]`);
      if (!currentCheckbox) {
        console.error(`❌ Checkbox for ${sellerId} not found in DOM`);
        await saveSellerData({ id: i + 1, unique_id: sellerId, email: "Not found - Checkbox missing" });
        continue;
      }

      console.log("🖱️  Clicking: Seller checkbox");
      scrollToAndClick(currentCheckbox);
      await sleep(600);

      console.log("🖱️  Clicking: Apply button (1st click)");
      click('[data-test="@web/FacetModalButtons/ApplyButton"]');
      reportAutomationProgress("first-filter-apply-clicked");
      await sleep(1200);

      // Target may perform a full category-page navigation on the final Apply.
      // Persist enough state for the newly loaded content script to continue.
      await saveApplyResumeCheckpoint(sellerId, i + 1, sellerName);
      console.log("🖱️  Clicking: Apply button (2nd click)");
      click('[data-test="@web/FacetModalButtons/ApplyButton"]');
      reportAutomationProgress("second-filter-apply-clicked");
      await sleep(2000);

      // Product results can load slowly after applying a seller. Wait for up to
      // 30 seconds before deciding that this seller has no product to open.
      const firstProductLink = await waitForFirstProductLink(30000);
      if (!firstProductLink) {
        console.warn(`⚠️ No product link for ${sellerName} after waiting 30 seconds`);
        await saveSellerData({
          id: i + 1,
          unique_id: sellerId,
          email: "Not found - No products after 30 seconds",
          store_link: "Not found",
          error_reason: "No product appeared after waiting 30 seconds"
        });
        await clearApplyResumeCheckpoint(sellerId);

        // Re-open filters for next seller
        await openFiltersAndSellerPanel();
        continue;
      }

      const productUrl = firstProductLink.href;
      const finalSellerData = await collectSellerFromProductUrl(productUrl, sellerId, i + 1);

      if (finalSellerData) {
        await saveSellerData(finalSellerData);
      }
      await clearApplyResumeCheckpoint(sellerId);

      console.log(`✅ [${attemptedPendingCount}/${pendingSellerCount}] ${sellerName} completed`);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

      // We're still on main page! Re-open filters for next seller
      console.log("🔄 Preparing for next seller...");
      await sleep(1000);

      // Check stop flag again before continuing
      if (shouldStopAutomation) {
        console.log("🛑 ========================================");
        console.log("🛑 AUTOMATION STOPPED BY USER");
        console.log("🛑 ========================================");
        console.log(`📊 Attempted ${attemptedPendingCount} of ${pendingSellerCount} Not Found sellers`);
        await logSellerDataAsJSON();
        return;
      }

      // Verify we're still on product listing - recover if lost
      let stillOnListing = await verifyProductListingPage(5000);
      if (!stillOnListing) {
        console.warn("⚠️ Lost product listing page, attempting recovery...");
        stillOnListing = await recoverToProductListing();
        if (!stillOnListing) {
          console.error("❌ Product grid did not reappear after bounded recovery; trying the filter panel directly...");
        }
      }

      // Re-open filters + seller panel with retries
      const panelReady = await openFiltersAndSellerPanel();
      if (!panelReady) {
        console.warn("⚠️ Could not reopen filters panel; waiting and retrying one final bounded cycle...");
        await sleep(3000);
        const retryPanel = await openFiltersAndSellerPanel();
        if (!retryPanel) {
          console.error("❌ Still can't open filters after retries; skipping to the next seller...");
          continue;
        }
      }

    } catch (loopError) {
      // NEVER let any error stop the loop
      console.error(`❌ Unexpected error processing seller ${i + 1} (${sellerId}):`, loopError);
      console.log("⚠️ Saving error and continuing to next seller...");

      await clearApplyResumeCheckpoint(sellerId);

      try {
        await saveSellerData({
          id: i + 1,
          unique_id: sellerId,
          email: "Not found - Unexpected error",
          store_link: "Not found"
        });
      } catch (saveError) {
        console.error("❌ Even saving failed:", saveError);
      }

      // Try to recover for next iteration
      try {
        await sleep(3000);
        const recovered = await recoverToProductListing();
        if (recovered) {
          await openFiltersAndSellerPanel();
        } else {
          console.warn("⚠️ Listing recovery timed out; attempting the filter panel without reloading...");
          await openFiltersAndSellerPanel();
        }
      } catch (recoveryError) {
        console.error("❌ Recovery also failed:", recoveryError);
        // Still don't stop - the next iteration will try again
      }

      continue;
    }
  }

  console.log("🎉 ========================================");
  console.log("🎉 ALL SELLERS COMPLETED! DONE!");
  console.log("🎉 ========================================");
  console.log(`📊 Not Found sellers attempted: ${attemptedPendingCount}`);
  console.log("");

  await logSellerDataAsJSON();

  console.log("");
  console.log("💾 Data saved in chrome.storage.local (key: 'sellerData')");
  console.log("✅ Script execution finished.");
  await finishAutomationRun("all-sellers-complete");

}

// A Target filter Apply can replace the category document. Resume from the
// persisted checkpoint without requiring another popup click.
setTimeout(() => {
  bootstrapAutomationContinuation().catch((error) => {
    console.error("Automatic automation restart failed:", error);
    void requestAutomationRestart(
      error && error.message ? error.message : "automatic restart bootstrap failed"
    );
  });
}, 750);

} // end of duplicate injection guard

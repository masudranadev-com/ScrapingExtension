// --------------------
// Prevent duplicate injection
// --------------------
if (window.__targetMailHunterLoaded) {
  console.log("Content script already loaded, skipping re-injection");
} else {
window.__targetMailHunterLoaded = true;

// --------------------
// Global state
// --------------------
let shouldStopAutomation = false;
let isAutomationRunning = false;

// --------------------
// Utility helpers
// --------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function click(selector) {
  const el = document.querySelector(selector);
  if (el) {
    el.click();
    return true;
  }
  console.warn("Element not found:", selector);
  return false;
}

// --------------------
// Message listener
// --------------------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "START_AUTOMATION") {
    if (isAutomationRunning) {
      console.log("⚠️ Automation already running, ignoring duplicate start");
      return;
    }
    shouldStopAutomation = false;
    runAutomation();
  } else if (msg.action === "STOP_AUTOMATION") {
    shouldStopAutomation = true;
    console.log("🛑 STOP requested by user");
  }
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
      if (closeBtn) closeBtn.click();
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

    // Try going back
    window.history.back();
    await sleep(3000);

    const backWorked = await verifyProductListingPage(5000);
    if (backWorked) return true;

    console.warn(`⚠️ Recovery attempt ${attempt} failed, retrying...`);
    await sleep(2000);
  }
  return false;
}

async function runAutomation() {
  isAutomationRunning = true;
  console.log("🚀 Automation started");

  try {
    // Extract and cache category info
    const categoryName = extractCategoryName();
    const breadcrumbSteps = extractBreadcrumbSteps();
    if (categoryName) {
      await saveCategoryData(categoryName, breadcrumbSteps);
    }

    // Open Filters + Seller panel with retries
    const opened = await openFiltersAndSellerPanel();
    if (!opened) {
      console.error("❌ Could not open filters/seller panel after all retries. Stopping.");
      return;
    }

    // Collect emails
    await collectSellerEmails();
  } finally {
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

async function saveSellerData(sellerData) {
  const data = await getStorage("sellerData", []);
  data.push({
    business_name: "Not found",
    email: "Not found",
    headquarters: "Not found",
    mobile_number: "Not found",
    store_link: "Not found",
    error_reason: "",
    ...sellerData
  });
  await setStorage({ sellerData: data });
}

async function setCurrentSellerIndex(index) {
  await setStorage({ currentSellerIndex: index });
}

async function getCurrentSellerIndex() {
  return getStorage("currentSellerIndex", 0);
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
    cb.click();
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

  // Scroll into view
  element.scrollIntoView({ behavior: "smooth", block: "center" });

  // Click the element
  element.click();
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
function findInNewTab(newTab, text, tagFilter = "a,button,span,div") {
  try {
    const candidates = newTab.document.querySelectorAll(tagFilter);
    const target = text.trim().toLowerCase();
    for (const el of candidates) {
      if (el.textContent && el.textContent.trim().toLowerCase().includes(target)) {
        return el;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function findContactTab(newTab) {
  try {
    return (
      newTab.document.querySelector('[data-test="tabContact"]') ||
      newTab.document.querySelector('#tab-Contact') ||
      newTab.document.querySelector('button[aria-controls="tabContent-tab-Contact"]') ||
      findInNewTab(newTab, "Contact", "button")
    );
  } catch {
    return null;
  }
}

async function waitForContactTab(newTab, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const tab = findContactTab(newTab);
    if (tab) return tab;
    await sleep(500);
  }
  return null;
}

async function waitForNewTabDocument(newTab, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (newTab.document) return true;
    } catch {
      // Cross-origin or not ready
    }
    await sleep(250);
  }
  return false;
}

async function findSoldByLinkWithRetries(newTab, attempts = 5, delayMs = 2000) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`🔍 [${attempt}/${attempts}] Looking for "Sold & shipped by"...`);

    let soldByLink =
      findInNewTab(newTab, "Sold & shipped by", "a") ||
      findInNewTab(newTab, "Sold & shipped by", "button") ||
      findInNewTab(newTab, "Sold & shipped by") ||
      findInNewTab(newTab, "Sold and shipped by");

    if (soldByLink) return soldByLink;

    console.warn("⚠️ 'Sold & shipped by' not found yet, waiting...");
    await sleep(delayMs);
  }

  return null;
}

async function getContactDataWithRetries(newTab, attempts = 3, delayMs = 8000) {
  let lastContactText = null;
  let lastParsed = null;
  let lastReason = "Contact tab not found";

  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`🔍 [${attempt}/${attempts}] Checking contact tab/content...`);

    const contactTab = await waitForContactTab(newTab, 5000);
    if (contactTab) {
      try {
        contactTab.scrollIntoView({ behavior: "smooth", block: "center" });
        contactTab.click();
      } catch (error) {
        lastReason = error && error.message ? error.message : "Contact tab click error";
        console.warn("Contact tab click attempt failed:", error);
        if (attempt < attempts) await sleep(delayMs);
        continue;
      }
      await sleep(2000);

      let contactContentEl = null;
      try {
        contactContentEl = newTab.document.querySelector('[data-test="tab-tabContent-tab-Contact"]');
      } catch (error) {
        lastReason = error && error.message ? error.message : "Contact extraction error";
        console.warn("Contact extraction attempt failed:", error);
        if (attempt < attempts) await sleep(delayMs);
        continue;
      }
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

async function extractSellerDataFromNewTab(newTab, sellerId, sellerIndex) {
  console.log(`🔗 New tab URL: ${newTab.location.href}`);
  console.log("🔗 Searching for 'Sold & shipped by' link in new tab...");

  await sleep(500);
  const soldByLink = await findSoldByLinkWithRetries(newTab, 5, 2000);

  if (!soldByLink) {
    console.warn("⚠️ 'Sold & shipped by' not found in new tab");
    return {
      retry: false,
      sellerData: {
        id: sellerIndex,
        unique_id: sellerId,
        email: "Sold & shipped by not found",
        store_link: "Not found",
        error_reason: "Sold & shipped by not found"
      }
    };
  }

  console.log("✅ Found 'Sold & shipped by' link in new tab");
  console.log("🖱️  Clicking in new tab...");

  soldByLink.scrollIntoView({ behavior: "smooth", block: "center" });
  soldByLink.click();
  await sleep(1500);

  const sellerPageUrl = newTab.location.href;
  console.log(`🔗 Seller page URL: ${sellerPageUrl}`);

  const contactData = await getContactDataWithRetries(newTab, 3, 8000);
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
    console.warn("⚠️ Seller checkboxes not found, retrying with page reload...");
    window.location.reload();
    await sleep(5000);
    const retryOpen = await openFiltersAndSellerPanel();
    if (!retryOpen) {
      console.error("❌ Seller checkboxes still not found after reload. Stopping.");
      return;
    }
    // Re-check checkboxes
    tempCheckboxes = document.querySelectorAll('input[data-test^="facet-checkbox-"]');
    if (tempCheckboxes.length <= 1) {
      console.error("❌ No seller checkboxes found even after reload. Stopping.");
      return;
    }
  }

  await sleep(500); // Extra wait for stability

  console.log("🔍 Filtering seller checkboxes...");

  // Filter out "Include out of stock" and disabled checkboxes
  let skipped = 0;
  let disabled = 0;

  const sellerCheckboxes = [...tempCheckboxes].filter((input) => {
    const dataTest = input.getAttribute("data-test") || "";

    // Filter out "Include out of stock" checkbox
    const inputValue = (input.value || "").toLowerCase();
    if (dataTest === "facet-checkbox-include_out_of_stock" || dataTest.includes("out_of_stock") || inputValue.includes("out of stock")) {
      skipped++;
      return false;
    }

    if (input.disabled || input.getAttribute("aria-disabled") === "true") {
      disabled++;
      return false;
    }

    return true;
  });

  console.log(`✅ Valid sellers found: ${sellerCheckboxes.length}`);
  console.log(`   - Skipped "Include out of stock": ${skipped}`);
  console.log(`   - Skipped disabled: ${disabled}`);

  // Save total sellers count to storage
  await setStorage({ totalSellers: sellerCheckboxes.length });

  if (sellerCheckboxes.length === 0) {
    console.warn("❌ No valid seller checkboxes found. Exiting.");
    return;
  }

  let startIndex = await getCurrentSellerIndex();
  if (startIndex < 0 || startIndex >= sellerCheckboxes.length) startIndex = 0;

  console.log(`🔄 Resuming from seller ${startIndex + 1} of ${sellerCheckboxes.length}`);

  for (let i = startIndex; i < sellerCheckboxes.length; i++) {
    // Check if user requested stop
    if (shouldStopAutomation) {
      console.log("🛑 ========================================");
      console.log("🛑 AUTOMATION STOPPED BY USER");
      console.log("🛑 ========================================");
      console.log(`📊 Processed ${i} of ${sellerCheckboxes.length} sellers before stopping`);
      await logSellerDataAsJSON();
      return;
    }

    const input = sellerCheckboxes[i];
    if (!input) continue;

    const dataTest = input.getAttribute("data-test") || "";
    const sellerId = dataTest.replace("facet-checkbox-", "");

    try {
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`🔄 [${i + 1}/${sellerCheckboxes.length}] Processing seller: ${sellerId}`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      // Uncheck all currently checked seller checkboxes
      await uncheckAllSellers();

      // Get the current checkbox from DOM (in case DOM changed)
      const currentCheckbox = document.querySelector(`[data-test="facet-checkbox-${sellerId}"]`);
      if (!currentCheckbox) {
        console.error(`❌ Checkbox for ${sellerId} not found in DOM`);
        await saveSellerData({ id: i + 1, unique_id: sellerId, email: "Not found - Checkbox missing" });
        await setCurrentSellerIndex(i + 1);
        continue;
      }

      console.log("🖱️  Clicking: Seller checkbox");
      currentCheckbox.click();
      await sleep(600);

      console.log("🖱️  Clicking: Apply button (1st click)");
      click('[data-test="@web/FacetModalButtons/ApplyButton"]');
      await sleep(1200);

      console.log("🖱️  Clicking: Apply button (2nd click)");
      click('[data-test="@web/FacetModalButtons/ApplyButton"]');
      await sleep(2000);

      // Verify we're back on product listing
      const onProductListing = await verifyProductListingPage(8000);
      if (!onProductListing) {
        console.error(`❌ Failed to return to product listing for seller ${i + 1}`);
        await saveSellerData({ id: i + 1, unique_id: sellerId, email: "Not found - Navigation failed" });
        await setCurrentSellerIndex(i + 1);
        continue;
      }

      const firstProductLink = document.querySelector('a[data-test="@web/ProductCard/title"]');
      if (!firstProductLink) {
        console.warn(`⚠️ No product link for seller ${i + 1}`);
        await saveSellerData({
          id: i + 1,
          unique_id: sellerId,
          email: "Not found",
          store_link: "Not found"
        });
        await setCurrentSellerIndex(i + 1);

        // Re-open filters for next seller
        await openFiltersAndSellerPanel();
        continue;
      }

      // Get product URL and open in new tab
      const productUrl = firstProductLink.href;
      console.log(`🔗 Opening product in new tab: ${productUrl}`);

      let finalSellerData = null;

      const newTab = window.open(productUrl, "_blank");
      if (!newTab) {
        console.error("❌ Failed to open new tab (popup blocked?)");
        finalSellerData = {
          id: i + 1,
          unique_id: sellerId,
          email: "Not found - Popup blocked",
          store_link: "Not found"
        };
      } else {
        console.log("⏳ Waiting for new tab to initialize...");
        await sleep(1500);

        const tabReady = await waitForNewTabDocument(newTab, 5000);
        if (!tabReady) {
          console.error("❌ New tab did not initialize in time");
          try { newTab.close(); } catch(e) {}
          finalSellerData = {
            id: i + 1,
            unique_id: sellerId,
            email: "Not found - Tab load timeout",
            store_link: "Not found"
          };
        } else {
          try {
            const result = await extractSellerDataFromNewTab(newTab, sellerId, i + 1);
            finalSellerData = result.sellerData;
            try { newTab.close(); } catch(e) {}
            await sleep(300);
          } catch (error) {
            console.error("❌ Error working with new tab:", error);
            try { newTab.close(); } catch(e) {}
            finalSellerData = {
              id: i + 1,
              unique_id: sellerId,
              email: "Not found - Tab error",
              store_link: "Not found"
            };
          }
        }
      }

      if (finalSellerData) {
        await saveSellerData(finalSellerData);
      }

      await setCurrentSellerIndex(i + 1);

      console.log(`✅ [${i + 1}/${sellerCheckboxes.length}] Seller ${i + 1} completed`);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

      // We're still on main page! Re-open filters for next seller
      console.log("🔄 Preparing for next seller...");
      await sleep(1000);

      // Check stop flag again before continuing
      if (shouldStopAutomation) {
        console.log("🛑 ========================================");
        console.log("🛑 AUTOMATION STOPPED BY USER");
        console.log("🛑 ========================================");
        console.log(`📊 Processed ${i + 1} of ${sellerCheckboxes.length} sellers before stopping`);
        await logSellerDataAsJSON();
        return;
      }

      // Verify we're still on product listing - recover if lost
      let stillOnListing = await verifyProductListingPage(5000);
      if (!stillOnListing) {
        console.warn("⚠️ Lost product listing page, attempting recovery...");
        stillOnListing = await recoverToProductListing();
        if (!stillOnListing) {
          console.error("❌ Could not recover product listing, but continuing to next seller...");
          await saveSellerData({ id: i + 1, unique_id: sellerId, email: "Not found - Page recovery failed" });
          await setCurrentSellerIndex(i + 1);
          // Try reloading the page and reopening filters
          window.location.reload();
          await sleep(5000);
        }
      }

      // Re-open filters + seller panel with retries
      const panelReady = await openFiltersAndSellerPanel();
      if (!panelReady) {
        console.warn("⚠️ Could not reopen filters panel, trying page reload...");
        window.location.reload();
        await sleep(5000);
        // After reload, try once more
        const retryPanel = await openFiltersAndSellerPanel();
        if (!retryPanel) {
          console.error("❌ Still can't open filters after reload, skipping to next seller...");
          continue;
        }
      }

    } catch (loopError) {
      // NEVER let any error stop the loop
      console.error(`❌ Unexpected error processing seller ${i + 1} (${sellerId}):`, loopError);
      console.log("⚠️ Saving error and continuing to next seller...");

      try {
        await saveSellerData({
          id: i + 1,
          unique_id: sellerId,
          email: "Not found - Unexpected error",
          store_link: "Not found"
        });
        await setCurrentSellerIndex(i + 1);
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
          window.location.reload();
          await sleep(5000);
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
  console.log(`📊 Total sellers processed: ${sellerCheckboxes.length}`);
  console.log("");

  await logSellerDataAsJSON();

  console.log("");
  console.log("💾 Data saved in chrome.storage.local (key: 'sellerData')");
  console.log("✅ Script execution finished.");

  // Reset index for next run
  await setCurrentSellerIndex(0);
}

} // end of duplicate injection guard

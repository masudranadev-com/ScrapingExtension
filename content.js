// --------------------
// Global state
// --------------------
let shouldStopAutomation = false;

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
    shouldStopAutomation = false;
    runAutomation();
  } else if (msg.action === "STOP_AUTOMATION") {
    shouldStopAutomation = true;
    console.log("ðŸ›‘ STOP requested by user");
  }
});

// --------------------
// Main flow
// --------------------
async function runAutomation() {
  console.log("ðŸš€ Automation started");

  // Open Filters
  console.log("ðŸ–±ï¸  Clicking: Filters menu");
  click('[data-test="filters-menu"]');
  await sleep(800);

  // Verify modal opened
  const modalOpen = await verifyModalOpen();
  if (!modalOpen) {
    console.error("âŒ Failed to open filters modal. Stopping.");
    return;
  }

  // Open Sold by
  console.log("ðŸ–±ï¸  Clicking: Sold by button");
  click('[data-test="facet-group-d_sellers_all"]');
  await sleep(1200);

  // Verify seller panel opened
  const sellerPanelOpen = await verifySellerPanelOpen();
  if (!sellerPanelOpen) {
    console.error("âŒ Failed to open seller panel. Stopping.");
    return;
  }

  // Collect emails
  await collectSellerEmails();
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
  data.push(sellerData);
  await setStorage({ sellerData: data });
}

async function setCurrentSellerIndex(index) {
  await setStorage({ currentSellerIndex: index });
}

async function getCurrentSellerIndex() {
  return getStorage("currentSellerIndex", 0);
}

async function setPreviousSellerId(sellerId) {
  await setStorage({ previousSellerId: sellerId });
}

async function getPreviousSellerId() {
  return getStorage("previousSellerId", null);
}

async function logSellerDataAsJSON() {
  const data = await getStorage("sellerData", []);
  console.log("ðŸ“Š SELLER DATA (JSON):");
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
// Page State Verification
// --------------------
async function verifyModalOpen(timeout = 5000) {
  console.log("ðŸ” Verifying modal is open...");
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const modal = document.querySelector('div[role="dialog"][aria-modal="true"]');
    if (modal) {
      console.log("âœ… Modal confirmed open");
      return true;
    }
    await sleep(200);
  }
  console.warn("âŒ Modal not detected!");
  return false;
}

async function verifySellerPanelOpen(timeout = 5000) {
  console.log("ðŸ” Verifying seller panel is open...");
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const checkboxes = document.querySelectorAll('input[data-test^="facet-checkbox-"]');
    if (checkboxes.length > 1) {
      console.log(`âœ… Seller panel confirmed open (${checkboxes.length} checkboxes found)`);
      return true;
    }
    await sleep(200);
  }
  console.warn("âŒ Seller panel not detected!");
  return false;
}

async function verifyProductListingPage(timeout = 5000) {
  console.log("ðŸ” Verifying we're on product listing page...");
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const productCards = document.querySelectorAll('[data-test="@web/site-top-of-funnel/ProductCardWrapper"]');
    if (productCards.length > 0) {
      console.log(`âœ… Product listing confirmed (${productCards.length} products found)`);
      return true;
    }
    await sleep(200);
  }
  console.warn("âŒ Product listing page not detected!");
  return false;
}

async function verifyProductPage(timeout = 5000) {
  console.log("ðŸ” Verifying we're on product detail page...");
  const start = Date.now();
  while (Date.now() - start < timeout) {
    // Check for product-specific elements
    const addToCart = document.querySelector('[data-test="shippingAddToCartButton"]');
    const productTitle = document.querySelector('h1');
    if (addToCart || (productTitle && productTitle.textContent.length > 0)) {
      console.log("âœ… Product page confirmed");
      return true;
    }
    await sleep(200);
  }
  console.warn("âŒ Product page not detected!");
  return false;
}

async function verifySellerPage(timeout = 5000) {
  console.log("ðŸ” Verifying we're on seller page...");
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const contactTab = document.querySelector('[data-test="tabContact"]');
    if (contactTab) {
      console.log("âœ… Seller page confirmed");
      return true;
    }
    await sleep(200);
  }
  console.warn("âŒ Seller page not detected!");
  return false;
}

async function verifyContactTabOpen(timeout = 5000) {
  console.log("ðŸ” Verifying contact tab is open...");
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const contactContent = document.querySelector('[data-test="tab-tabContent-tab-Contact"]');
    if (contactContent && contactContent.textContent.length > 0) {
      console.log("âœ… Contact tab confirmed open");
      return true;
    }
    await sleep(200);
  }
  console.warn("âŒ Contact tab not detected!");
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
    console.warn(`âŒ Cannot click ${description} - element is null`);
    return false;
  }

  console.log(`ðŸ–±ï¸  Preparing to click: ${description}`);
  console.log(`   Element type: ${element.tagName}`);
  console.log(`   Element text: ${element.textContent?.substring(0, 50)}`);
  console.log(`   Element visible: ${element.offsetParent !== null}`);

  // Scroll into view
  element.scrollIntoView({ behavior: "smooth", block: "center" });

  // Click the element
  element.click();
  console.log(`âœ… Clicked: ${description}`);
  return true;
}

function getModal() {
  return document.querySelector('div[role="dialog"][aria-modal="true"]');
}

function parseContactText(text) {
  const emailMatch = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
  const businessNameMatch = text.match(/Legal Business Name:\s*([^H]+?)(?=Headquarters:|$)/);
  const headquartersMatch = text.match(/Headquarters:(.+?)(?:Contact|Partner Information|$)/s);

  const businessName = businessNameMatch ? businessNameMatch[1].trim() : "Not found";
  const email = emailMatch ? emailMatch[0] : "Not found";
  let headquarters = "Not found";
  if (headquartersMatch) {
    headquarters = headquartersMatch[1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(", ");
  }

  return { businessName, email, headquarters };
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
    console.log(`ðŸ” [${attempt}/${attempts}] Looking for "Sold & shipped by"...`);

    let soldByLink =
      findInNewTab(newTab, "Sold & shipped by", "a") ||
      findInNewTab(newTab, "Sold & shipped by", "button") ||
      findInNewTab(newTab, "Sold & shipped by") ||
      findInNewTab(newTab, "Sold and shipped by");

    if (soldByLink) return soldByLink;

    console.warn("âš ï¸ 'Sold & shipped by' not found yet, waiting...");
    await sleep(delayMs);
  }

  return null;
}

async function getContactDataWithRetries(newTab, attempts = 3, delayMs = 8000) {
  let lastContactText = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`ðŸ” [${attempt}/${attempts}] Checking contact tab/content...`);

    const contactTab = await waitForContactTab(newTab, 5000);
    if (contactTab) {
      contactTab.scrollIntoView({ behavior: "smooth", block: "center" });
      contactTab.click();
      await sleep(2000);

      const contactContentEl = newTab.document.querySelector('[data-test="tab-tabContent-tab-Contact"]');
      if (contactContentEl && contactContentEl.textContent && contactContentEl.textContent.trim().length > 0) {
        lastContactText = contactContentEl.textContent;
        const parsed = parseContactText(lastContactText);

        if (parsed.email !== "Not found") {
          return { parsed, contactText: lastContactText };
        }

        console.warn("âš ï¸ Email not found yet, waiting for more data...");
      } else {
        console.warn("âš ï¸ Contact content empty, waiting...");
      }
    } else {
      console.warn("âš ï¸ Contact tab not found yet.");
    }

    await sleep(delayMs);
  }

  if (lastContactText) {
    return { parsed: parseContactText(lastContactText), contactText: lastContactText };
  }

  return null;
}

async function extractSellerDataFromNewTab(newTab, sellerId, sellerIndex) {
  console.log(`Ã°Å¸â€Â New tab URL: ${newTab.location.href}`);
  console.log("Ã°Å¸â€Â Searching for 'Sold & shipped by' link in new tab...");

  await sleep(500);
  const soldByLink = await findSoldByLinkWithRetries(newTab, 5, 2000);

  if (!soldByLink) {
    console.warn("Ã¢Å¡Â Ã¯Â¸Â 'Sold & shipped by' not found in new tab");
    return {
      retry: true,
      sellerData: {
        id: sellerIndex,
        unique_id: sellerId,
        email: "Sold & shipped by not found",
        store_link: "Not found"
      }
    };
  }

  console.log("Ã¢Å“â€¦ Found 'Sold & shipped by' link in new tab");
  console.log("Ã°Å¸â€“Â±Ã¯Â¸Â  Clicking in new tab...");

  soldByLink.scrollIntoView({ behavior: "smooth", block: "center" });
  soldByLink.click();
  await sleep(1500);

  const sellerPageUrl = newTab.location.href;
  console.log(`Ã°Å¸â€Â Seller page URL: ${sellerPageUrl}`);

  const contactData = await getContactDataWithRetries(newTab, 3, 8000);
  if (contactData) {
    const parsed = contactData.parsed;
    const emailFound = parsed.email !== "Not found";

    console.log(`Ã°Å¸â€œÂ§ Extracted - Business: ${parsed.businessName}, Email: ${parsed.email}`);
    console.log(`Ã°Å¸â€â€” Store Link: ${sellerPageUrl}`);

    return {
      retry: !emailFound,
      sellerData: {
        id: sellerIndex,
        unique_id: sellerId,
        business_name: parsed.businessName,
        email: parsed.email,
        headquarters: parsed.headquarters,
        store_link: sellerPageUrl
      }
    };
  }

  console.warn("Ã¢Å¡Â Ã¯Â¸Â Contact tab/content not available after waiting");
  return {
    retry: true,
    sellerData: {
      id: sellerIndex,
      unique_id: sellerId,
      email: "Not found - No contact tab",
      store_link: sellerPageUrl
    }
  };
}

// --------------------
// Seller loop
// --------------------
async function collectSellerEmails() {
  console.log("â³ Waiting for seller panel to load...");

  // Wait for seller checkboxes to appear (not just the modal)
  let tempCheckboxes = null;
  let attempts = 0;
  while (attempts < 10) {
    await sleep(500);
    tempCheckboxes = document.querySelectorAll('input[data-test^="facet-checkbox-"]');
    console.log(`ðŸ” Attempt ${attempts + 1}: Found ${tempCheckboxes.length} seller checkboxes`);

    if (tempCheckboxes.length > 1) { // More than just "Include out of stock"
      console.log("âœ… Seller checkboxes loaded!");
      break;
    }
    attempts++;
  }

  if (tempCheckboxes.length <= 1) {
    console.warn("âŒ Seller checkboxes not found after waiting");
    return;
  }

  await sleep(500); // Extra wait for stability

  console.log("ðŸ” Filtering seller checkboxes...");

  // Filter out "Include out of stock" and disabled checkboxes
  let skipped = 0;
  let disabled = 0;

  const sellerCheckboxes = [...tempCheckboxes].filter((input) => {
    const dataTest = input.getAttribute("data-test") || "";

    // Filter out "Include out of stock" checkbox
    if (dataTest === "facet-checkbox-include_out_of_stock" || dataTest.includes("out_of_stock")) {
      skipped++;
      return false;
    }

    if (input.disabled || input.getAttribute("aria-disabled") === "true") {
      disabled++;
      return false;
    }

    return true;
  });

  console.log(`âœ… Valid sellers found: ${sellerCheckboxes.length}`);
  console.log(`   - Skipped "Include out of stock": ${skipped}`);
  console.log(`   - Skipped disabled: ${disabled}`);

  if (sellerCheckboxes.length === 0) {
    console.warn("âŒ No valid seller checkboxes found. Exiting.");
    return;
  }

  let startIndex = await getCurrentSellerIndex();
  if (startIndex < 0 || startIndex >= sellerCheckboxes.length) startIndex = 0;

  let previousSellerId = await getPreviousSellerId();

  console.log(`ðŸ”„ Resuming from seller ${startIndex + 1} of ${sellerCheckboxes.length}`);

  for (let i = startIndex; i < sellerCheckboxes.length; i++) {
    // Check if user requested stop
    if (shouldStopAutomation) {
      console.log("ðŸ›‘ ========================================");
      console.log("ðŸ›‘ AUTOMATION STOPPED BY USER");
      console.log("ðŸ›‘ ========================================");
      console.log(`ðŸ“Š Processed ${i} of ${sellerCheckboxes.length} sellers before stopping`);
      await logSellerDataAsJSON();
      return;
    }

    const input = sellerCheckboxes[i];
    if (!input) continue;

    const dataTest = input.getAttribute("data-test") || "";
    const sellerId = dataTest.replace("facet-checkbox-", "");

    console.log(`\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”`);
    console.log(`ðŸ”„ [${i + 1}/${sellerCheckboxes.length}] Processing seller: ${sellerId}`);
    console.log(`â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n`);

    // Uncheck previous seller if still checked
    if (previousSellerId) {
      console.log(`ðŸ”„ Unchecking previous seller: ${previousSellerId}`);
      const prev = document.querySelector(`[data-test="facet-checkbox-${previousSellerId}"]`);
      if (prev && prev.checked) {
        console.log("âœ… Previous seller was checked, unchecking...");
        prev.click();
        await sleep(400);
      } else {
        console.log("â„¹ï¸ Previous seller already unchecked");
      }
    }

    // Get the current checkbox from DOM (in case DOM changed)
    const currentCheckbox = document.querySelector(`[data-test="facet-checkbox-${sellerId}"]`);
    if (!currentCheckbox) {
      console.error(`âŒ Checkbox for ${sellerId} not found in DOM`);
      continue;
    }

    console.log("ðŸ–±ï¸  Clicking: Seller checkbox");
    currentCheckbox.click();
    await sleep(600);

    console.log("ðŸ–±ï¸  Clicking: Apply button (1st click)");
    click('[data-test="@web/FacetModalButtons/ApplyButton"]');
    await sleep(1200);

    console.log("ðŸ–±ï¸  Clicking: Apply button (2nd click)");
    click('[data-test="@web/FacetModalButtons/ApplyButton"]');
    await sleep(2000);

    // Verify we're back on product listing
    const onProductListing = await verifyProductListingPage(8000);
    if (!onProductListing) {
      console.error(`âŒ Failed to return to product listing for seller ${i + 1}`);
      await saveSellerData({ id: i + 1, unique_id: sellerId, email: "Not found - Navigation failed" });
      await setCurrentSellerIndex(i + 1);
      await setPreviousSellerId(sellerId);
      previousSellerId = sellerId;
      continue;
    }

    const firstProductLink = document.querySelector('a[data-test="@web/ProductCard/title"]');
    if (!firstProductLink) {
      console.warn(`âš ï¸ No product link for seller ${i + 1}`);
      await saveSellerData({
        id: i + 1,
        unique_id: sellerId,
        email: "Not found",
        store_link: "Not found"
      });
      await setCurrentSellerIndex(i + 1);
      await setPreviousSellerId(sellerId);
      previousSellerId = sellerId;

      // Re-open filters for next seller
      console.log("ðŸ–±ï¸  Clicking: Filters menu");
      click('[data-test="filters-menu"]');
      await sleep(800);
      await verifyModalOpen();
      console.log("ðŸ–±ï¸  Clicking: Sold by button");
      click('[data-test="facet-group-d_sellers_all"]');
      await sleep(1200);
      await verifySellerPanelOpen();
      continue;
    }    // Get product URL and open in new tab (retry same store if no data)
    const productUrl = firstProductLink.href;
    console.log(`🔗 Opening product in new tab: ${productUrl}`);

    let finalSellerData = null;
    let attemptsLeft = 2;

    while (attemptsLeft > 0) {
      const newTab = window.open(productUrl, "_blank");
      if (!newTab) {
        console.error("❌ Failed to open new tab (popup blocked?)");
        finalSellerData = {
          id: i + 1,
          unique_id: sellerId,
          email: "Not found - Popup blocked",
          store_link: "Not found"
        };
        break;
      }

      console.log("⏳ Waiting for new tab to initialize...");
      await sleep(1500);

      const tabReady = await waitForNewTabDocument(newTab, 5000);
      if (!tabReady) {
        console.error("❌ New tab did not initialize in time");
        newTab.close();
        finalSellerData = {
          id: i + 1,
          unique_id: sellerId,
          email: "Not found - Tab load timeout",
          store_link: "Not found"
        };
        break;
      }

      try {
        const result = await extractSellerDataFromNewTab(newTab, sellerId, i + 1);
        finalSellerData = result.sellerData;
        newTab.close();
        await sleep(300);

        if (result.retry && attemptsLeft > 1) {
          console.warn("🔁 No data yet. Retrying the same store...");
          attemptsLeft -= 1;
          continue;
        }

        break;
      } catch (error) {
        console.error("❌ Error working with new tab:", error);
        newTab.close();
        finalSellerData = {
          id: i + 1,
          unique_id: sellerId,
          email: "Not found - Tab error",
          store_link: "Not found"
        };
        break;
      }
    }

    if (finalSellerData) {
      await saveSellerData(finalSellerData);
    }

    await setCurrentSellerIndex(i + 1);
    await setPreviousSellerId(sellerId);

    console.log(`âœ… [${i + 1}/${sellerCheckboxes.length}] Seller ${i + 1} completed`);
    console.log("â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n");

    // We're still on main page! Re-open filters for next seller
    console.log("ðŸ”„ Preparing for next seller...");
    await sleep(1000);

    // Check stop flag again before continuing
    if (shouldStopAutomation) {
      console.log("ðŸ›‘ ========================================");
      console.log("ðŸ›‘ AUTOMATION STOPPED BY USER");
      console.log("ðŸ›‘ ========================================");
      console.log(`ðŸ“Š Processed ${i + 1} of ${sellerCheckboxes.length} sellers before stopping`);
      await logSellerDataAsJSON();
      return;
    }

    // Verify we're still on product listing
    const stillOnListing = await verifyProductListingPage(5000);
    if (!stillOnListing) {
      console.error("âŒ Lost product listing page");
      break;
    }

    // Re-open filters
    console.log("ðŸ–±ï¸  Clicking: Filters menu");
    click('[data-test="filters-menu"]');
    await sleep(800);

    const modalReopened = await verifyModalOpen(5000);
    if (!modalReopened) {
      console.error("âŒ Failed to reopen filters modal");
      break;
    }

    // Re-open "Sold by" panel
    console.log("ðŸ–±ï¸  Clicking: Sold by button");
    click('[data-test="facet-group-d_sellers_all"]');
    await sleep(1200);

    // Wait for seller checkboxes to reload
    await sleep(1000);

    previousSellerId = sellerId;
  }

  console.log("ðŸŽ‰ ========================================");
  console.log("ðŸŽ‰ ALL SELLERS COMPLETED! DONE!");
  console.log("ðŸŽ‰ ========================================");
  console.log(`ðŸ“Š Total sellers processed: ${sellerCheckboxes.length}`);
  console.log("");

  await logSellerDataAsJSON();

  console.log("");
  console.log("ðŸ’¾ Data saved in chrome.storage.local (key: 'sellerData')");
  console.log("âœ… Script execution finished.");

  // Reset indices for next run
  await setCurrentSellerIndex(0);
  await setPreviousSellerId(null);
}


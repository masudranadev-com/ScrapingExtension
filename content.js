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
    console.log("🛑 STOP requested by user");
  }
});

// --------------------
// Main flow
// --------------------
async function runAutomation() {
  console.log("🚀 Automation started");

  // Open Filters
  console.log("🖱️  Clicking: Filters menu");
  click('[data-test="filters-menu"]');
  await sleep(800);

  // Verify modal opened
  const modalOpen = await verifyModalOpen();
  if (!modalOpen) {
    console.error("❌ Failed to open filters modal. Stopping.");
    return;
  }

  // Open Sold by
  console.log("🖱️  Clicking: Sold by button");
  click('[data-test="facet-group-d_sellers_all"]');
  await sleep(1200);

  // Verify seller panel opened
  const sellerPanelOpen = await verifySellerPanelOpen();
  if (!sellerPanelOpen) {
    console.error("❌ Failed to open seller panel. Stopping.");
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
// Seller loop
// --------------------
async function collectSellerEmails() {
  console.log("⏳ Waiting for seller panel to load...");

  // Wait for seller checkboxes to appear (not just the modal)
  let tempCheckboxes = null;
  let attempts = 0;
  while (attempts < 10) {
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
    console.warn("❌ Seller checkboxes not found after waiting");
    return;
  }

  await sleep(500); // Extra wait for stability

  console.log("🔍 Filtering seller checkboxes...");

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

  console.log(`✅ Valid sellers found: ${sellerCheckboxes.length}`);
  console.log(`   - Skipped "Include out of stock": ${skipped}`);
  console.log(`   - Skipped disabled: ${disabled}`);

  if (sellerCheckboxes.length === 0) {
    console.warn("❌ No valid seller checkboxes found. Exiting.");
    return;
  }

  let startIndex = await getCurrentSellerIndex();
  if (startIndex < 0 || startIndex >= sellerCheckboxes.length) startIndex = 0;

  let previousSellerId = await getPreviousSellerId();

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

    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🔄 [${i + 1}/${sellerCheckboxes.length}] Processing seller: ${sellerId}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    // Uncheck previous seller if still checked
    if (previousSellerId) {
      console.log(`🔄 Unchecking previous seller: ${previousSellerId}`);
      const prev = document.querySelector(`[data-test="facet-checkbox-${previousSellerId}"]`);
      if (prev && prev.checked) {
        console.log("✅ Previous seller was checked, unchecking...");
        prev.click();
        await sleep(400);
      } else {
        console.log("ℹ️ Previous seller already unchecked");
      }
    }

    // Get the current checkbox from DOM (in case DOM changed)
    const currentCheckbox = document.querySelector(`[data-test="facet-checkbox-${sellerId}"]`);
    if (!currentCheckbox) {
      console.error(`❌ Checkbox for ${sellerId} not found in DOM`);
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
      await setPreviousSellerId(sellerId);
      previousSellerId = sellerId;
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
      await setPreviousSellerId(sellerId);
      previousSellerId = sellerId;

      // Re-open filters for next seller
      console.log("🖱️  Clicking: Filters menu");
      click('[data-test="filters-menu"]');
      await sleep(800);
      await verifyModalOpen();
      console.log("🖱️  Clicking: Sold by button");
      click('[data-test="facet-group-d_sellers_all"]');
      await sleep(1200);
      await verifySellerPanelOpen();
      continue;
    }

    // Get product URL and open in new tab
    const productUrl = firstProductLink.href;
    console.log(`🔗 Opening product in new tab: ${productUrl}`);

    const newTab = window.open(productUrl, '_blank');
    if (!newTab) {
      console.error("❌ Failed to open new tab (popup blocked?)");
      await saveSellerData({
        id: i + 1,
        unique_id: sellerId,
        email: "Not found - Popup blocked",
        store_link: "Not found"
      });
      await setCurrentSellerIndex(i + 1);
      await setPreviousSellerId(sellerId);
      previousSellerId = sellerId;
      continue;
    }

    console.log("⏳ Waiting for new tab to load...");
    await sleep(4000); // Give new tab time to load

    // Switch focus to new tab to work with it
    console.log("🔄 Working in new tab...");

    // Wait for new tab to be ready
    let tabReady = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        if (newTab.document && newTab.document.readyState === 'complete') {
          tabReady = true;
          console.log("✅ New tab loaded");
          break;
        }
      } catch (e) {
        // Cross-origin or not ready yet
      }
      await sleep(500);
    }

    if (!tabReady) {
      console.error("❌ New tab did not load in time");
      newTab.close();
      await saveSellerData({
        id: i + 1,
        unique_id: sellerId,
        email: "Not found - Tab load timeout",
        store_link: "Not found"
      });
      await setCurrentSellerIndex(i + 1);
      await setPreviousSellerId(sellerId);
      previousSellerId = sellerId;
      continue;
    }

    // Now extract data from the NEW TAB
    try {
      console.log(`🔍 New tab URL: ${newTab.location.href}`);
      console.log("🔍 Searching for 'Sold & shipped by' link in new tab...");

      // Helper function to find element in new tab
      function findInNewTab(text, tagFilter = "a,button,span,div") {
        const candidates = newTab.document.querySelectorAll(tagFilter);
        const target = text.trim().toLowerCase();
        for (const el of candidates) {
          if (el.textContent && el.textContent.trim().toLowerCase().includes(target)) {
            return el;
          }
        }
        return null;
      }

      await sleep(1000);
      let soldByLink = findInNewTab("Sold & shipped by", "a");

      if (!soldByLink) {
        soldByLink = findInNewTab("Sold & shipped by", "button");
      }
      if (!soldByLink) {
        soldByLink = findInNewTab("Sold & shipped by");
      }
      if (!soldByLink) {
        soldByLink = findInNewTab("Sold and shipped by");
      }

      if (soldByLink) {
        console.log("✅ Found 'Sold & shipped by' link in new tab");
        console.log(`🖱️  Clicking in new tab...`);

        soldByLink.scrollIntoView({ behavior: "smooth", block: "center" });
        soldByLink.click();
        await sleep(3000);

        const sellerPageUrl = newTab.location.href;
        console.log(`🔍 Seller page URL: ${sellerPageUrl}`);

        // Check if contact tab exists
        const contactTab = newTab.document.querySelector('[data-test="tabContact"]');
        if (contactTab) {
          console.log("🖱️  Clicking Contact tab in new tab");
          contactTab.click();
          await sleep(1500);

          const contactContentEl = newTab.document.querySelector('[data-test="tab-tabContent-tab-Contact"]');
          if (contactContentEl && contactContentEl.textContent) {
            const contactText = contactContentEl.textContent;
            const parsed = parseContactText(contactText);

            console.log(`📧 Extracted - Business: ${parsed.businessName}, Email: ${parsed.email}`);
            console.log(`🔗 Store Link: ${sellerPageUrl}`);

            await saveSellerData({
              id: i + 1,
              unique_id: sellerId,
              business_name: parsed.businessName,
              email: parsed.email,
              headquarters: parsed.headquarters,
              store_link: sellerPageUrl
            });
          } else {
            console.warn("⚠️ Contact content not found in new tab");
            await saveSellerData({
              id: i + 1,
              unique_id: sellerId,
              email: "Not found - No contact content",
              store_link: sellerPageUrl
            });
          }
        } else {
          console.warn("⚠️ Contact tab not found in new tab");
          await saveSellerData({
            id: i + 1,
            unique_id: sellerId,
            email: "Not found - No contact tab",
            store_link: sellerPageUrl
          });
        }
      } else {
        console.warn("⚠️ 'Sold & shipped by' link not found in new tab");
        await saveSellerData({
          id: i + 1,
          unique_id: sellerId,
          email: "Not found - No seller link",
          store_link: "Not found"
        });
      }
    } catch (error) {
      console.error("❌ Error working with new tab:", error);
      await saveSellerData({
        id: i + 1,
        unique_id: sellerId,
        email: "Not found - Tab error",
        store_link: "Not found"
      });
    }

    // Close the new tab
    console.log("🔒 Closing new tab...");
    newTab.close();
    await sleep(500);
    console.log("✅ New tab closed, back on main page");

    await setCurrentSellerIndex(i + 1);
    await setPreviousSellerId(sellerId);

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

    // Verify we're still on product listing
    const stillOnListing = await verifyProductListingPage(5000);
    if (!stillOnListing) {
      console.error("❌ Lost product listing page");
      break;
    }

    // Re-open filters
    console.log("🖱️  Clicking: Filters menu");
    click('[data-test="filters-menu"]');
    await sleep(800);

    const modalReopened = await verifyModalOpen(5000);
    if (!modalReopened) {
      console.error("❌ Failed to reopen filters modal");
      break;
    }

    // Re-open "Sold by" panel
    console.log("🖱️  Clicking: Sold by button");
    click('[data-test="facet-group-d_sellers_all"]');
    await sleep(1200);

    // Wait for seller checkboxes to reload
    await sleep(1000);

    previousSellerId = sellerId;
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

  // Reset indices for next run
  await setCurrentSellerIndex(0);
  await setPreviousSellerId(null);
}

let isRunning = false;
const startButton = document.getElementById("start");
const viewDataButton = document.getElementById("viewData");

async function ensureLatestContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
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

  const loaded = await ensureLatestContentScript(tab.id);
  if (!loaded) return;

  chrome.tabs.sendMessage(tab.id, { action: "COLLECT_SELLER_NAMES_V3" }, () => {
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
    const loaded = await ensureLatestContentScript(tab.id);
    if (!loaded) return;

    chrome.tabs.sendMessage(tab.id, { action: "START_AUTOMATION_V3" }, () => {
      if (chrome.runtime.lastError) return;
      window.close();
    });
  } else {
    // Stop automation
    chrome.tabs.sendMessage(tab.id, { action: "STOP_AUTOMATION_V3" }, () => {
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
viewDataButton.addEventListener("click", () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL('viewer.html')
  });
});

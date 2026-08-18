let isRunning = false;
const startButton = document.getElementById("start");
const viewDataButton = document.getElementById("viewData");
const signalDockClientNamesUrl = "http://localhost:3000/target/client-names";
let signalDockSyncPromise = null;

function setLocalStorage(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function syncSignalDockClientNames() {
  if (signalDockSyncPromise) return signalDockSyncPromise;

  signalDockSyncPromise = (async () => {
    try {
      const response = await fetch(signalDockClientNamesUrl, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" }
      });

      let body;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      if (!response.ok) {
        throw new Error(
          body && body.msg ? String(body.msg) : `SignalDock returned HTTP ${response.status}`
        );
      }
      if (!Array.isArray(body)) {
        throw new Error("SignalDock response must be an array of seller names");
      }

      const names = body.filter((name) => typeof name === "string");
      await setLocalStorage({
        signalDockClientNames: names,
        signalDockClientNamesSucceeded: true,
        signalDockClientNamesError: "",
        signalDockClientNamesCheckedAt: new Date().toISOString()
      });
      console.log(`[SignalDock] Loaded ${names.length} existing seller names`);
      return { success: true, names, error: "" };
    } catch (error) {
      const errorMessage = error && error.message ? error.message : "SignalDock request failed";
      await setLocalStorage({
        signalDockClientNamesSucceeded: false,
        signalDockClientNamesError: errorMessage,
        signalDockClientNamesCheckedAt: new Date().toISOString()
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

  await syncSignalDockClientNames();

  const loaded = await ensureLatestContentScript(tab.id);
  if (!loaded) return;

  chrome.tabs.sendMessage(tab.id, { action: "COLLECT_SELLER_NAMES_V8" }, () => {
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

    chrome.tabs.sendMessage(tab.id, { action: "START_AUTOMATION_V8" }, () => {
      if (chrome.runtime.lastError) return;
      window.close();
    });
  } else {
    // Stop automation
    chrome.tabs.sendMessage(tab.id, { action: "STOP_AUTOMATION_V8" }, () => {
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

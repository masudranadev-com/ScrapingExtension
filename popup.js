let isRunning = false;
const startButton = document.getElementById("start");
const viewDataButton = document.getElementById("viewData");

// Start/Stop button
startButton.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!isRunning) {
    // Start automation - try sending message, inject script if not available
    chrome.tabs.sendMessage(tab.id, { action: "START_AUTOMATION" }, async () => {
      if (chrome.runtime.lastError) {
        console.warn("Content script not loaded, injecting now...");
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content.js"]
          });
          // Retry after injection
          chrome.tabs.sendMessage(tab.id, { action: "START_AUTOMATION" }, () => {
            if (chrome.runtime.lastError) {
              return;
            }
            window.close();
          });
        } catch (e) {
        }
        return;
      }
      // Message delivered, close popup
      window.close();
    });
  } else {
    // Stop automation
    chrome.tabs.sendMessage(tab.id, { action: "STOP_AUTOMATION" }, () => {
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

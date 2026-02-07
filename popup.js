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
    // Start automation
    chrome.tabs.sendMessage(tab.id, { action: "START_AUTOMATION" }, () => {
      if (chrome.runtime.lastError) {
        console.warn("Content script not available:", chrome.runtime.lastError.message);
        alert("This page is not ready for the extension. Please refresh the page or open a supported page, then try again.");
        return;
      }
    });

    // Change button to Stop
    startButton.textContent = "⏹ Stop";
    startButton.style.background = "#ff3b3b";
    startButton.style.color = "#ffffff";
    isRunning = true;
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

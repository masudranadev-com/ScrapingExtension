const SIGNALDOCK_CLIENT_NAMES_URL = "http://localhost:3000/target/client-names";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== "GET_SIGNALDOCK_CLIENT_NAMES") return false;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  fetch(SIGNALDOCK_CLIENT_NAMES_URL, {
    method: "GET",
    cache: "no-store",
    signal: controller.signal,
    headers: {
      Accept: "application/json"
    }
  })
    .then(async (response) => {
      let body;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      if (!response.ok) {
        const messageText = body && body.msg
          ? String(body.msg)
          : `SignalDock returned HTTP ${response.status}`;
        throw new Error(messageText);
      }

      if (!Array.isArray(body)) {
        throw new Error("SignalDock response must be an array of seller names");
      }

      console.log(`[SignalDock] Background worker loaded ${body.length} seller names`);
      sendResponse({
        success: true,
        names: body.filter((name) => typeof name === "string")
      });
    })
    .catch((error) => {
      console.error("[SignalDock] Background API request failed:", error);
      sendResponse({
        success: false,
        names: [],
        error: error && error.name === "AbortError"
          ? "SignalDock request timed out"
          : (error && error.message ? error.message : "SignalDock request failed")
      });
    })
    .finally(() => clearTimeout(timeoutId));

  return true;
});

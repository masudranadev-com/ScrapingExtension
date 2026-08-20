(() => {
  if (globalThis.__targetMailHunterLoggerInstalled) return;
  globalThis.__targetMailHunterLoggerInstalled = true;

  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  function getLogSource() {
    if (typeof document === "undefined") return "background";

    const path = String(window.location.pathname || "").toLowerCase();
    if (window.location.protocol === "chrome-extension:") {
      if (path.endsWith("popup.html")) return "popup";
      if (path.endsWith("viewer.html")) return "data-viewer";
      return "extension-page";
    }
    return "content";
  }

  function truncate(value, maximum = 12000) {
    const text = String(value);
    return text.length > maximum
      ? `${text.slice(0, maximum)}… [truncated ${text.length - maximum} characters]`
      : text;
  }

  function serializeValue(value, depth = 0, seen = new WeakSet()) {
    if (value === null) return null;
    if (value === undefined) return "undefined";
    if (typeof value === "string") return truncate(value);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return `${value.toString()}n`;
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
    if (typeof value !== "object") return truncate(value);

    if (value instanceof Error) {
      return {
        name: value.name,
        message: truncate(value.message),
        stack: truncate(value.stack || "")
      };
    }

    if (typeof Element !== "undefined" && value instanceof Element) {
      return {
        type: "Element",
        tagName: value.tagName,
        id: value.id || "",
        className: truncate(value.className || "", 1000),
        text: truncate((value.textContent || "").trim(), 2000)
      };
    }

    if (depth >= 4) return "[Maximum depth reached]";
    if (seen.has(value)) return "[Circular reference]";
    seen.add(value);

    if (Array.isArray(value)) {
      const result = value.slice(0, 100).map((item) => serializeValue(item, depth + 1, seen));
      if (value.length > 100) result.push(`[${value.length - 100} more items]`);
      return result;
    }

    const result = {};
    let keys = [];
    try {
      keys = Object.keys(value);
    } catch {
      return "[Unreadable object]";
    }

    for (const key of keys.slice(0, 100)) {
      try {
        result[key] = serializeValue(value[key], depth + 1, seen);
      } catch (error) {
        result[key] = `[Unreadable: ${error && error.message ? error.message : "unknown error"}]`;
      }
    }
    if (keys.length > 100) result.__truncatedKeys = keys.length - 100;
    return result;
  }

  function valueToMessage(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try {
      return JSON.stringify(serializeValue(value));
    } catch {
      return String(value);
    }
  }

  function createLogEntry(level, args) {
    const source = getLogSource();
    let pageUrl = "service-worker";
    if (typeof window !== "undefined" && window.location) {
      pageUrl = window.location.href;
    }

    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      timestamp: new Date().toISOString(),
      level,
      source,
      pageUrl: truncate(pageUrl, 4000),
      message: truncate(args.map(valueToMessage).join(" "), 16000),
      details: args.map((value) => serializeValue(value))
    };
  }

  function forwardLog(entry) {
    if (entry.source === "background") {
      if (globalThis.TMHLogStore && typeof globalThis.TMHLogStore.append === "function") {
        globalThis.TMHLogStore.append(entry);
      }
      return;
    }

    try {
      chrome.runtime.sendMessage({ action: "APPEND_EXTENSION_LOG", entry }, () => {
        try {
          void chrome.runtime.lastError;
        } catch {
          // The extension context may disappear during page navigation.
        }
      });
    } catch {
      // The original console output still works if the extension is unloading.
    }
  }

  for (const level of ["log", "warn", "error"]) {
    console[level] = (...args) => {
      originalConsole[level](...args);
      try {
        forwardLog(createLogEntry(level, args));
      } catch (error) {
        originalConsole.error("[TMH Logger] Failed to capture log:", error);
      }
    };
  }

  globalThis.TMHLogger = {
    originalConsole,
    createLogEntry
  };
})();

const LOG_STORAGE_KEY = "extensionLogs";

const state = {
  logs: [],
  autoRefresh: true,
  refreshTimer: null,
  inspectedEntry: null,
  modalCloseTimer: null
};

const elements = {
  rows: document.getElementById("logRows"),
  empty: document.getElementById("emptyState"),
  search: document.getElementById("searchInput"),
  level: document.getElementById("levelFilter"),
  source: document.getElementById("sourceFilter"),
  toggleRefresh: document.getElementById("toggleRefresh"),
  exportLogs: document.getElementById("exportLogs"),
  clearLogs: document.getElementById("clearLogs"),
  liveStatus: document.getElementById("liveStatus"),
  liveText: document.getElementById("liveText"),
  total: document.getElementById("totalCount"),
  info: document.getElementById("infoCount"),
  warning: document.getElementById("warningCount"),
  error: document.getElementById("errorCount"),
  resultSummary: document.getElementById("resultSummary"),
  lastUpdated: document.getElementById("lastUpdated"),
  modal: document.getElementById("logModal"),
  modalClose: document.getElementById("modalClose"),
  modalLevel: document.getElementById("modalLevel"),
  modalSubtitle: document.getElementById("modalSubtitle"),
  modalTime: document.getElementById("modalTime"),
  modalSource: document.getElementById("modalSource"),
  modalTabId: document.getElementById("modalTabId"),
  modalPageUrl: document.getElementById("modalPageUrl"),
  modalLogId: document.getElementById("modalLogId"),
  modalMessage: document.getElementById("modalMessage"),
  modalDetails: document.getElementById("modalDetails"),
  copyLog: document.getElementById("copyLog")
};

function formatDateTime(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return String(timestamp || "Unknown");
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${offsetSign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)} ${offset}`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function getFilteredLogs() {
  const query = elements.search.value.trim().toLowerCase();
  const level = elements.level.value;
  const source = elements.source.value;

  return state.logs.filter((entry) => {
    if (level !== "all" && entry.level !== level) return false;
    if (source !== "all" && entry.source !== source) return false;
    if (!query) return true;
    const searchable = [entry.message, entry.source, entry.pageUrl, safeJson(entry.details)]
      .join(" ")
      .toLowerCase();
    return searchable.includes(query);
  });
}

function updateSourceOptions() {
  const selected = elements.source.value;
  const sources = [...new Set(state.logs.map((entry) => entry.source).filter(Boolean))].sort();
  elements.source.replaceChildren(new Option("All sources", "all"));
  for (const source of sources) elements.source.add(new Option(source, source));
  elements.source.value = sources.includes(selected) ? selected : "all";
}

function updateStats() {
  elements.total.textContent = state.logs.length.toLocaleString();
  elements.info.textContent = state.logs.filter((entry) => entry.level === "log").length.toLocaleString();
  elements.warning.textContent = state.logs.filter((entry) => entry.level === "warn").length.toLocaleString();
  elements.error.textContent = state.logs.filter((entry) => entry.level === "error").length.toLocaleString();
}

function createCell(className = "") {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  return cell;
}

function getLevelLabel(level) {
  if (level === "warn") return "Warning";
  if (level === "error") return "Error";
  return "Info";
}

function openInspectModal(entry) {
  if (state.modalCloseTimer) {
    clearTimeout(state.modalCloseTimer);
    state.modalCloseTimer = null;
  }
  state.inspectedEntry = entry;
  elements.modalLevel.className = `badge ${entry.level || "log"}`;
  elements.modalLevel.textContent = getLevelLabel(entry.level);
  elements.modalSubtitle.textContent = `${entry.source || "unknown"} event · ${entry.timestamp || "time unavailable"}`;
  elements.modalTime.textContent = formatDateTime(entry.timestamp);
  elements.modalSource.textContent = entry.source || "unknown";
  elements.modalTabId.textContent = entry.tabId === null || entry.tabId === undefined ? "Not associated" : String(entry.tabId);
  elements.modalPageUrl.textContent = entry.pageUrl || "Not available";
  elements.modalLogId.textContent = entry.id || "Not available";
  elements.modalMessage.textContent = entry.message || "(empty message)";
  elements.modalDetails.textContent = safeJson(entry.details);
  elements.copyLog.textContent = "Copy complete log";

  elements.modal.hidden = false;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => {
    elements.modal.classList.add("open");
    elements.modalClose.focus();
  });
}

function closeInspectModal() {
  elements.modal.classList.remove("open");
  document.body.classList.remove("modal-open");
  state.modalCloseTimer = setTimeout(() => {
    elements.modal.hidden = true;
    state.inspectedEntry = null;
    state.modalCloseTimer = null;
  }, 180);
}

function render() {
  const filtered = getFilteredLogs().slice().reverse();
  const fragment = document.createDocumentFragment();

  for (const entry of filtered) {
    const row = document.createElement("tr");

    const timeCell = createCell("time");
    timeCell.textContent = formatDateTime(entry.timestamp);
    timeCell.title = entry.timestamp || "";

    const levelCell = createCell();
    const badge = document.createElement("span");
    badge.className = `badge ${entry.level || "log"}`;
    badge.textContent = getLevelLabel(entry.level);
    levelCell.appendChild(badge);

    const sourceCell = createCell("source");
    sourceCell.textContent = entry.source || "unknown";
    sourceCell.title = entry.pageUrl || "";

    const messageCell = createCell("message");
    messageCell.textContent = entry.message || "(empty message)";

    const detailsCell = createCell();
    const inspectButton = document.createElement("button");
    inspectButton.type = "button";
    inspectButton.className = "inspect-button";
    inspectButton.textContent = "Inspect";
    inspectButton.addEventListener("click", () => openInspectModal(entry));
    detailsCell.appendChild(inspectButton);

    row.append(timeCell, levelCell, sourceCell, messageCell, detailsCell);
    fragment.appendChild(row);
  }

  elements.rows.replaceChildren(fragment);
  elements.empty.classList.toggle("visible", filtered.length === 0);
  elements.resultSummary.textContent = `Showing ${filtered.length.toLocaleString()} of ${state.logs.length.toLocaleString()} entries`;
}

async function loadLogs() {
  if (!state.autoRefresh) return;
  const result = await chrome.storage.local.get(LOG_STORAGE_KEY);
  state.logs = Array.isArray(result[LOG_STORAGE_KEY]) ? result[LOG_STORAGE_KEY] : [];
  updateSourceOptions();
  updateStats();
  render();
  elements.lastUpdated.textContent = `Updated ${formatDateTime(new Date().toISOString())}`;
}

function downloadJson() {
  const blob = new Blob([JSON.stringify(state.logs, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `target-mail-hunter-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

elements.search.addEventListener("input", render);
elements.level.addEventListener("change", render);
elements.source.addEventListener("change", render);

elements.toggleRefresh.addEventListener("click", async () => {
  state.autoRefresh = !state.autoRefresh;
  elements.toggleRefresh.textContent = state.autoRefresh ? "Pause live" : "Resume live";
  elements.liveStatus.classList.toggle("paused", !state.autoRefresh);
  elements.liveText.textContent = state.autoRefresh ? "Live · auto-refreshing" : "Live updates paused";
  if (state.autoRefresh) await loadLogs();
});

elements.exportLogs.addEventListener("click", downloadJson);

elements.modalClose.addEventListener("click", closeInspectModal);
elements.modal.addEventListener("click", (event) => {
  if (event.target === elements.modal) closeInspectModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.modal.hidden) closeInspectModal();
});
elements.copyLog.addEventListener("click", async () => {
  if (!state.inspectedEntry) return;
  try {
    await navigator.clipboard.writeText(safeJson(state.inspectedEntry));
    elements.copyLog.textContent = "Copied!";
  } catch {
    elements.copyLog.textContent = "Copy failed";
  }
  setTimeout(() => {
    elements.copyLog.textContent = "Copy complete log";
  }, 1400);
});

elements.clearLogs.addEventListener("click", async () => {
  if (!confirm("Clear every stored extension log? This cannot be undone.")) return;
  await chrome.storage.local.set({ [LOG_STORAGE_KEY]: [] });
  state.logs = [];
  updateSourceOptions();
  updateStats();
  render();
  elements.lastUpdated.textContent = "Logs cleared";
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (!state.autoRefresh || areaName !== "local" || !changes[LOG_STORAGE_KEY]) return;
  state.logs = Array.isArray(changes[LOG_STORAGE_KEY].newValue)
    ? changes[LOG_STORAGE_KEY].newValue
    : [];
  updateSourceOptions();
  updateStats();
  render();
  elements.lastUpdated.textContent = `Updated ${formatDateTime(new Date().toISOString())}`;
});

state.refreshTimer = setInterval(loadLogs, 2000);
loadLogs();

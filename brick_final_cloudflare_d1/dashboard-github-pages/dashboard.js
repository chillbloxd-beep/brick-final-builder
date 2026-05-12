import { DASHBOARD_CONFIG as CFG } from "./config.js";

const $ = id => document.getElementById(id);

let ws = null;
let cmdId = 0;
let pending = new Map();
let autoTabs = CFG.UI.AUTO_REFRESH_TABS;
let tabsTimer = null;
let lastHistoryRows = [];

function apiBase() {
  return CFG.WORKER_BASE_URL.trim().replace(/\/$/, "");
}

function wsUrl() {
  const base = CFG.WORKER_BASE_URL.trim().replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "");
  const qs = new URLSearchParams({
    key: CFG.API_KEY,
    role: "dashboard",
    deviceId: "dashboard",
    deviceName: "Dashboard"
  });
  return `${base}/ws/${encodeURIComponent(CFG.ROOM_ID)}?${qs.toString()}`;
}

function setStatus(text, tone = "") {
  $("status").textContent = text;
  $("status").className = "pill " + tone;
}

function log(entry) {
  const line = typeof entry === "string" ? entry : JSON.stringify(entry, null, 2);
  $("debugLog").textContent = `[${new Date().toLocaleTimeString()}] ${line}\n` + $("debugLog").textContent;
}

function connect() {
  disconnect(false);
  ws = new WebSocket(wsUrl());
  setStatus("Connecting...", "warn");

  ws.onopen = () => {
    setStatus("Connected", "ok");
    send({ type: "presence" });
    if (autoTabs) startAutoTabs();
  };

  ws.onmessage = event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handleMessage(msg);
  };

  ws.onclose = () => setStatus("Disconnected", "bad");
  ws.onerror = () => setStatus("Error", "bad");
}

function disconnect(closeSocket = true) {
  clearInterval(tabsTimer);
  tabsTimer = null;
  if (closeSocket && ws) {
    try { ws.close(); } catch (_) {}
  }
  ws = null;
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert("Dashboard is not connected.");
    return false;
  }
  ws.send(JSON.stringify(obj));
  return true;
}

function command(type, payload = {}, handler = null) {
  const id = "cmd-" + (++cmdId);
  if (handler) pending.set(id, handler);
  send({ type: "command", id, command: { type, payload } });
  log({ sent: { id, type, payload } });
}

function handleMessage(msg) {
  if (["joined", "presence", "peer-joined", "peer-left"].includes(msg.type)) {
    renderPeers(msg.peers || []);
    log(msg);
    return;
  }

  if (msg.type === "status") {
    log(msg);
    return;
  }

  if (msg.type === "log") {
    log(msg);
    return;
  }

  if (msg.type === "tabs") {
    renderTabs(msg.payload?.tabs || [], msg.payload?.windows || []);
    return;
  }

  if (msg.type === "frame") {
    $("liveImage").src = msg.dataUrl;
    $("liveImage").hidden = false;
    $("liveMeta").textContent = `Frame ${new Date(msg.capturedAt).toLocaleTimeString()} • ${msg.tab?.title || ""} • ${msg.tab?.url || ""}`;
    return;
  }

  if (msg.type === "command-result") {
    log(msg);

    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }

    if (msg.result?.tabs) renderTabs(msg.result.tabs, msg.result.windows || []);

    if (msg.result?.dataUrl) {
      $("liveImage").src = msg.result.dataUrl;
      $("liveImage").hidden = false;
      $("liveMeta").textContent = `Single capture ${new Date(msg.result.capturedAt).toLocaleTimeString()} • ${msg.result.tab?.title || ""}`;
    }
  }
}

function renderPeers(peers) {
  if (!peers.length) {
    $("peers").textContent = "No peers connected.";
    return;
  }
  $("peers").innerHTML = peers.map(p => `
    <span class="peer ${p.role === "agent" ? "agent" : ""}">
      ${escapeHtml(p.role)}:${escapeHtml(p.deviceName || p.deviceId || "?")}
    </span>
  `).join("");
}

function requestTabs() {
  command("GET_TABS");
}

function startAutoTabs() {
  clearInterval(tabsTimer);
  if (!autoTabs) return;
  tabsTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) requestTabs();
  }, CFG.UI.TAB_REFRESH_MS || 2500);
}

function renderTabs(tabs, windows) {
  const normal = (tabs || []).filter(t => /^https?:\/\//i.test(t.url || ""));
  const grouped = {};

  for (const tab of normal) {
    if (!grouped[tab.windowId]) grouped[tab.windowId] = [];
    grouped[tab.windowId].push(tab);
  }

  $("tabsSummary").textContent = `${normal.length} normal tab(s), ${Object.keys(grouped).length} window(s). Last refresh: ${new Date().toLocaleTimeString()}`;

  $("tabsPanel").innerHTML = Object.entries(grouped).map(([windowId, list]) => {
    const win = (windows || []).find(w => String(w.id) === String(windowId));
    return `
      <div class="window">
        <div class="win-head">
          <b>Window ${escapeHtml(windowId)}</b>
          <span>${win?.focused ? "Focused" : "Not focused"} • ${list.length} tab(s)</span>
          <button data-close-window="${escapeHtml(windowId)}" class="danger mini">Close Window</button>
        </div>
        ${list.sort((a, b) => a.index - b.index).map(tab => `
          <div class="tab ${tab.active ? "active" : ""}">
            <div>
              <b>${tab.active ? "● " : ""}${escapeHtml(tab.title || "Untitled")}</b>
              <small>${escapeHtml(tab.url || "")}</small>
              <small>ID ${tab.id} ${tab.pinned ? "• pinned" : ""} ${tab.audible ? "• audible" : ""} ${tab.muted ? "• muted" : ""} ${tab.status ? "• " + escapeHtml(tab.status) : ""}</small>
            </div>
            <div class="tab-actions">
              <button data-activate="${tab.id}" class="mini">Activate</button>
              <button data-close-tab="${tab.id}" class="danger mini">Close</button>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }).join("") || `<p class="muted">No http/https tabs found.</p>`;

  document.querySelectorAll("[data-activate]").forEach(btn => {
    btn.onclick = () => command("ACTIVATE_TAB", { tabId: Number(btn.dataset.activate) }, () => setTimeout(requestTabs, 500));
  });

  document.querySelectorAll("[data-close-tab]").forEach(btn => {
    btn.onclick = () => command("CLOSE_TAB", { tabId: Number(btn.dataset.closeTab) }, () => setTimeout(requestTabs, 500));
  });

  document.querySelectorAll("[data-close-window]").forEach(btn => {
    btn.onclick = () => {
      if (confirm("Close this entire browser window?")) {
        command("CLOSE_WINDOW", { windowId: Number(btn.dataset.closeWindow) }, () => setTimeout(requestTabs, 700));
      }
    };
  });
}

async function fetchHistory() {
  const params = new URLSearchParams({
    key: CFG.API_KEY,
    limit: String(CFG.UI.HISTORY_LIMIT || 150)
  });

  if ($("historyDevice").value.trim()) params.set("deviceId", $("historyDevice").value.trim());
  if ($("historyEvent").value.trim()) params.set("eventType", $("historyEvent").value.trim());
  if ($("historySearch").value.trim()) params.set("q", $("historySearch").value.trim());

  const res = await fetch(`${apiBase()}/api/history?${params.toString()}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "History fetch failed");

  lastHistoryRows = data.rows || [];
  renderHistory(lastHistoryRows);
}

function renderHistory(rows) {
  $("historySummary").textContent = `${rows.length} row(s). Last refresh: ${new Date().toLocaleTimeString()}`;
  const tbody = document.querySelector("#historyTable tbody");
  tbody.innerHTML = rows.map(row => `
    <tr>
      <td>${escapeHtml(row.created_at || "")}</td>
      <td>${escapeHtml(row.device_name || row.device_id || "")}</td>
      <td><b>${escapeHtml(row.event_type || "")}</b></td>
      <td>${escapeHtml(row.title || "")}</td>
      <td>${escapeHtml(row.url || "")}</td>
      <td>${escapeHtml(row.command || "")}</td>
      <td>${escapeHtml(row.status || "")}</td>
      <td>${escapeHtml(row.source || "")}</td>
    </tr>
  `).join("");
}

async function cleanupHistory() {
  if (!confirm("Delete all history older than 60 days now?")) return;
  const res = await fetch(`${apiBase()}/api/cleanup?key=${encodeURIComponent(CFG.API_KEY)}`, { method: "POST" });
  const data = await res.json();
  log(data);
  await fetchHistory();
}

function exportCsv() {
  const headers = ["created_at", "device_id", "device_name", "event_type", "title", "url", "command", "status", "source", "extra_json"];
  const lines = [headers.join(",")];
  for (const row of lastHistoryRows) {
    lines.push(headers.map(h => csvCell(row[h] || "")).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `brick-history-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const str = String(value).replace(/"/g, '""');
  return `"${str}"`;
}

function loadDefaultRules() {
  const r = CFG.DEFAULT_RULES;
  $("allowDomains").value = (r.allowDomains || []).join("\n");
  $("blockDomains").value = (r.blockDomains || []).join("\n");
  $("blockKeywords").value = (r.blockKeywords || []).join("\n");
  $("alertKeywords").value = (r.alertKeywords || []).join("\n");
  $("tabLimit").value = r.tabLimit || 0;
}

function lines(id) {
  return $(id).value.split("\n").map(x => x.trim()).filter(Boolean);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c]));
}

document.querySelectorAll("[data-view]").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll("[data-view]").forEach(b => b.classList.remove("nav-active"));
    document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
    btn.classList.add("nav-active");
    $(btn.dataset.view).classList.add("active");
    if (btn.dataset.view === "historyView") fetchHistory().catch(err => alert(err.message));
  };
});

$("connectBtn").onclick = connect;
$("disconnectBtn").onclick = () => disconnect(true);
$("presenceBtn").onclick = () => send({ type: "presence" });

$("startLiveBtn").onclick = () => command("START_LIVE", { fps: CFG.LIVE.DEFAULT_FPS || 2 });
$("stopLiveBtn").onclick = () => command("STOP_LIVE");
$("resetLiveBtn").onclick = () => command("RESET_LIVE", { fps: CFG.LIVE.DEFAULT_FPS || 2 });
$("hardReconnectBtn").onclick = () => command("HARD_RECONNECT", { fps: CFG.LIVE.DEFAULT_FPS || 2 });
$("captureOnceBtn").onclick = () => command("CAPTURE_ONCE");

document.querySelectorAll("[data-cmd]").forEach(btn => {
  btn.onclick = () => command(btn.dataset.cmd);
});

$("openUrlBtn").onclick = () => command("OPEN_URL", { url: $("openUrl").value.trim() });
$("messageBtn").onclick = () => command("MESSAGE", { text: $("messageText").value });

$("refreshTabsBtn").onclick = requestTabs;
$("autoTabsBtn").onclick = () => {
  autoTabs = !autoTabs;
  $("autoTabsBtn").textContent = `Auto Tabs: ${autoTabs ? "On" : "Off"}`;
  startAutoTabs();
};

$("applyRulesBtn").onclick = () => command("SET_RULES", {
  allowDomains: lines("allowDomains"),
  blockDomains: lines("blockDomains"),
  blockKeywords: lines("blockKeywords"),
  alertKeywords: lines("alertKeywords"),
  tabLimit: Number($("tabLimit").value || 0),
  focusMode: $("applyFocus").checked,
  lockMode: $("applyLock").checked
});

$("resetRulesBtn").onclick = () => {
  loadDefaultRules();
  command("RESET_RULES");
};

$("refreshHistoryBtn").onclick = () => fetchHistory().catch(err => alert(err.message));
$("cleanupBtn").onclick = () => cleanupHistory().catch(err => alert(err.message));
$("exportCsvBtn").onclick = exportCsv;

loadDefaultRules();
$("autoTabsBtn").textContent = `Auto Tabs: ${autoTabs ? "On" : "Off"}`;

if (CFG.UI.AUTO_CONNECT) {
  setTimeout(connect, 250);
}

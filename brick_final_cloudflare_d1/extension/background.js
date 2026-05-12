import { CONFIG } from "./config.js";

const BLOCKED_URL = chrome.runtime.getURL("blocked.html");
const DEFAULT_SETTINGS = {
  enabled: true,
  focusMode: false,
  lockMode: false,
  allowDomains: CONFIG.RULES.DEFAULT_ALLOW_DOMAINS,
  blockDomains: CONFIG.RULES.DEFAULT_BLOCK_DOMAINS,
  blockKeywords: CONFIG.RULES.DEFAULT_BLOCK_KEYWORDS,
  alertKeywords: CONFIG.RULES.DEFAULT_ALERT_KEYWORDS,
  tabLimit: CONFIG.RULES.TAB_LIMIT || 0
};

let ws = null;
let reconnectTimer = null;
let liveTimer = null;
let liveOn = false;
let currentSettings = { ...DEFAULT_SETTINGS };
let lastTabsSent = 0;

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["settings", "historyQueue"]);
  currentSettings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  await chrome.storage.local.set({ settings: currentSettings, historyQueue: stored.historyQueue || [] });
  await rebuildRules();
  await setBadge(false);
  connect();
  chrome.alarms.create("keepAlive", { periodInMinutes: 0.5 });
  chrome.alarms.create("flushHistory", { periodInMinutes: Math.max(0.25, (CONFIG.HISTORY.FLUSH_EVERY_SECONDS || 20) / 60) });
  chrome.alarms.create("tabLimitCheck", { periodInMinutes: 0.25 });
  await queueHistory("EXTENSION_INSTALLED", { source: "extension" });
});

chrome.runtime.onStartup.addListener(() => connect());

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === "keepAlive") {
    if (!ws || ws.readyState !== WebSocket.OPEN) connect();
    await sendTabs();
  }
  if (alarm.name === "flushHistory") await flushHistory();
  if (alarm.name === "tabLimitCheck") await enforceTabLimit();
});

chrome.action.onClicked.addListener(() => {
  // Intentionally no UI and no student controls.
});

chrome.tabs.onActivated.addListener(async info => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    await sendTabs();
    await inspectTab(tab, "TAB_ACTIVATED");
  } catch (_) {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    await sendTabs();
    if (tab.active) await inspectTab(tab, "PAGE_LOADED");
  }
});

chrome.storage.onChanged.addListener(async changes => {
  if (changes.settings) {
    currentSettings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    await rebuildRules();
  }
});

function wsUrl() {
  const base = CONFIG.WORKER_BASE_URL.trim().replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "");
  const qs = new URLSearchParams({
    key: CONFIG.API_KEY,
    role: "agent",
    deviceId: CONFIG.DEVICE_ID,
    deviceName: CONFIG.DEVICE_NAME || CONFIG.DEVICE_ID
  });
  return `${base}/ws/${encodeURIComponent(CONFIG.ROOM_ID)}?${qs.toString()}`;
}

function apiUrl(path) {
  const base = CONFIG.WORKER_BASE_URL.trim().replace(/\/$/, "");
  return `${base}${path}`;
}

function connect() {
  clearTimeout(reconnectTimer);
  try { if (ws) ws.close(); } catch (_) {}

  ws = new WebSocket(wsUrl());

  ws.onopen = async () => {
    send({
      type: "hello",
      role: "agent",
      deviceId: CONFIG.DEVICE_ID,
      deviceName: CONFIG.DEVICE_NAME,
      version: "4.0.0"
    });
    sendStatus("Agent online");
    await sendTabs(true);
    await flushHistory();
  };

  ws.onmessage = async event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === "command") await handleCommand(msg);
  };

  ws.onclose = () => {
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    try { ws.close(); } catch (_) {}
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function sendStatus(text, extra = {}) {
  send({
    type: "status",
    deviceId: CONFIG.DEVICE_ID,
    deviceName: CONFIG.DEVICE_NAME,
    text,
    liveOn,
    extra
  });
}

async function handleCommand(msg) {
  const id = msg.id || crypto.randomUUID();
  const command = msg.command || {};
  const type = String(command.type || "").toUpperCase();
  const payload = command.payload || {};

  try {
    let result;

    switch (type) {
      case "PING":
        result = { pong: true, at: new Date().toISOString(), deviceId: CONFIG.DEVICE_ID };
        break;
      case "GET_TABS":
        result = await getTabsPayload();
        break;
      case "START_LIVE":
        result = await startLive(payload);
        break;
      case "STOP_LIVE":
        result = await stopLive();
        break;
      case "RESET_LIVE":
        result = await resetLive(payload, false);
        break;
      case "HARD_RECONNECT":
        result = await resetLive(payload, true);
        break;
      case "CAPTURE_ONCE":
        result = await captureOnce();
        break;
      case "ACTIVATE_TAB":
        result = await activateTab(payload.tabId);
        break;
      case "CLOSE_TAB":
        result = await closeTab(payload.tabId);
        break;
      case "CLOSE_WINDOW":
        result = await closeWindow(payload.windowId);
        break;
      case "OPEN_URL":
      case "SEND_LINK":
        result = await openUrl(payload.url);
        break;
      case "MESSAGE":
        result = await messageAll(payload.text);
        break;
      case "FOCUS_ON":
        result = await patchSettings({ focusMode: true, lockMode: false });
        break;
      case "FOCUS_OFF":
        result = await patchSettings({ focusMode: false });
        break;
      case "LOCK":
        result = await patchSettings({ lockMode: true });
        break;
      case "UNLOCK":
        result = await patchSettings({ lockMode: false });
        break;
      case "SET_RULES":
        result = await setRules(payload);
        break;
      case "RESET_RULES":
        result = await patchSettings({ ...DEFAULT_SETTINGS });
        break;
      case "CLOSE_OFFTASK":
        result = await closeOfftaskTabs();
        break;
      case "GET_SETTINGS":
        result = { settings: currentSettings };
        break;
      default:
        throw new Error("Unknown command: " + type);
    }

    send({ type: "command-result", id, ok: true, command: type, result });
    await queueHistory("COMMAND_EXECUTED", { command: type, status: "OK", source: "agent", extra: { id, payload } });
  } catch (err) {
    const error = String(err?.message || err);
    send({ type: "command-result", id, ok: false, command: type, error });
    await queueHistory("COMMAND_ERROR", { command: type, status: "ERROR", source: "agent", extra: { id, error, payload } });
  }
}

async function patchSettings(patch) {
  currentSettings = { ...currentSettings, ...(patch || {}) };
  await chrome.storage.local.set({ settings: currentSettings });
  await rebuildRules();
  await sendTabs(true);
  await queueHistory("SETTINGS_UPDATED", { source: "agent", extra: { patch } });
  return { settings: currentSettings };
}

async function setRules(payload) {
  const patch = {};
  if (typeof payload.enabled === "boolean") patch.enabled = payload.enabled;
  if (typeof payload.focusMode === "boolean") patch.focusMode = payload.focusMode;
  if (typeof payload.lockMode === "boolean") patch.lockMode = payload.lockMode;
  if (Array.isArray(payload.allowDomains)) patch.allowDomains = payload.allowDomains;
  if (Array.isArray(payload.blockDomains)) patch.blockDomains = payload.blockDomains;
  if (Array.isArray(payload.blockKeywords)) patch.blockKeywords = payload.blockKeywords;
  if (Array.isArray(payload.alertKeywords)) patch.alertKeywords = payload.alertKeywords;
  if (Number.isFinite(Number(payload.tabLimit))) patch.tabLimit = Number(payload.tabLimit);
  return patchSettings(patch);
}

function normalizeDomain(input) {
  return String(input || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
}

async function rebuildRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map(r => r.id),
    addRules: []
  });

  if (!currentSettings.enabled) return;

  const rules = [];
  let id = 1;

  if (currentSettings.lockMode) {
    rules.push({
      id: id++,
      priority: 10000,
      action: { type: "redirect", redirect: { url: BLOCKED_URL + "?reason=locked" } },
      condition: { urlFilter: "|http", resourceTypes: ["main_frame"] }
    });
  } else if (currentSettings.focusMode) {
    const allowed = (currentSettings.allowDomains || []).map(normalizeDomain).filter(Boolean);
    rules.push({
      id: id++,
      priority: 9000,
      action: { type: "redirect", redirect: { url: BLOCKED_URL + "?reason=focus" } },
      condition: { urlFilter: "|http", excludedRequestDomains: allowed, resourceTypes: ["main_frame"] }
    });
  }

  for (const d0 of (currentSettings.blockDomains || [])) {
    const d = normalizeDomain(d0);
    if (!d) continue;
    rules.push({
      id: id++,
      priority: 5000,
      action: { type: "redirect", redirect: { url: BLOCKED_URL + "?reason=domain&value=" + encodeURIComponent(d) } },
      condition: { requestDomains: [d], resourceTypes: ["main_frame"] }
    });
  }

  for (const kw0 of (currentSettings.blockKeywords || [])) {
    const kw = String(kw0 || "").trim();
    if (!kw) continue;
    rules.push({
      id: id++,
      priority: 4000,
      action: { type: "redirect", redirect: { url: BLOCKED_URL + "?reason=keyword&value=" + encodeURIComponent(kw) } },
      condition: { urlFilter: kw, resourceTypes: ["main_frame"] }
    });
  }

  if (rules.length) await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules });
}

async function getTabsPayload() {
  const tabs = await chrome.tabs.query({});
  const windows = await chrome.windows.getAll({ populate: false });

  return {
    deviceId: CONFIG.DEVICE_ID,
    deviceName: CONFIG.DEVICE_NAME,
    liveOn,
    settings: currentSettings,
    windows: windows.map(w => ({
      id: w.id,
      focused: !!w.focused,
      type: w.type,
      state: w.state
    })),
    tabs: tabs.map(t => ({
      id: t.id,
      windowId: t.windowId,
      index: t.index,
      active: !!t.active,
      highlighted: !!t.highlighted,
      pinned: !!t.pinned,
      audible: !!t.audible,
      muted: !!(t.mutedInfo && t.mutedInfo.muted),
      status: t.status || "",
      title: t.title || "",
      url: t.url || "",
      favIconUrl: t.favIconUrl || ""
    }))
  };
}

async function sendTabs(force = false) {
  const now = Date.now();
  if (!force && now - lastTabsSent < 500) return;
  lastTabsSent = now;
  send({ type: "tabs", payload: await getTabsPayload() });
}

async function startLive(payload = {}) {
  if (liveOn) return { liveOn: true, already: true };

  liveOn = true;
  await setBadge(true);

  const fps = Math.min(Math.max(Number(payload.fps || CONFIG.LIVE.MAX_SCREENSHOT_FPS || 2), 0.25), 2);
  const interval = Math.max(500, Math.floor(1000 / fps));

  clearInterval(liveTimer);
  liveTimer = setInterval(captureAndSendFrame, interval);
  await captureAndSendFrame();

  sendStatus("Live preview started", { fps });
  await queueHistory("LIVE_STARTED", { source: "agent", status: "OK", extra: { fps } });
  return { liveOn: true, fps, interval };
}

async function stopLive() {
  liveOn = false;
  clearInterval(liveTimer);
  liveTimer = null;
  await setBadge(false);
  sendStatus("Live preview stopped");
  await queueHistory("LIVE_STOPPED", { source: "agent" });
  return { liveOn: false };
}

async function resetLive(payload = {}, hard = false) {
  await stopLive();

  if (hard) {
    try { if (ws) ws.close(); } catch (_) {}
    await sleep(800);
    connect();
    await sleep(1200);
  } else {
    await sleep(700);
  }

  const result = await startLive(payload);
  sendStatus(hard ? "Hard reconnect + live reset complete" : "Live reset complete");
  await sendTabs(true);
  await queueHistory(hard ? "HARD_RECONNECT" : "RESET_LIVE", { source: "agent" });
  return { reset: true, hard, ...result };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function setBadge(on) {
  if (on && CONFIG.LIVE.SHOW_LIVE_BADGE) {
    await chrome.action.setBadgeText({ text: "LIVE" });
    await chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
    await chrome.action.setTitle({ title: "Brick Classroom Agent — LIVE VIEW ACTIVE" });
  } else {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "Brick Classroom Agent" });
  }
}

async function captureAndSendFrame() {
  if (!liveOn) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const dataUrl = await chrome.tabs.captureVisibleTab(tab?.windowId, {
      format: "jpeg",
      quality: Number(CONFIG.LIVE.JPEG_QUALITY || 45)
    });

    send({
      type: "frame",
      deviceId: CONFIG.DEVICE_ID,
      deviceName: CONFIG.DEVICE_NAME,
      capturedAt: Date.now(),
      tab: tab ? { id: tab.id, title: tab.title || "", url: tab.url || "" } : null,
      dataUrl
    });
  } catch (err) {
    sendStatus("Frame capture failed", { error: String(err?.message || err) });
  }
}

async function captureOnce() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const dataUrl = await chrome.tabs.captureVisibleTab(tab?.windowId, {
    format: "jpeg",
    quality: Number(CONFIG.LIVE.JPEG_QUALITY || 45)
  });

  await queueHistory("CAPTURE_ONCE", { source: "agent", title: tab?.title || "", url: tab?.url || "" });
  return {
    capturedAt: Date.now(),
    tab: tab ? { id: tab.id, title: tab.title || "", url: tab.url || "" } : null,
    dataUrl
  };
}

async function activateTab(tabId) {
  const id = Number(tabId);
  if (!Number.isFinite(id)) throw new Error("tabId required");
  const tab = await chrome.tabs.get(id);
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(id, { active: true });
  await sendTabs(true);
  await queueHistory("TAB_ACTIVATED_BY_DASHBOARD", { source: "agent", title: tab.title || "", url: tab.url || "" });
  return { tabId: id };
}

async function closeTab(tabId) {
  const id = Number(tabId);
  if (!Number.isFinite(id)) throw new Error("tabId required");
  const tab = await chrome.tabs.get(id).catch(() => null);
  await chrome.tabs.remove(id);
  await sendTabs(true);
  await queueHistory("TAB_CLOSED_BY_DASHBOARD", { source: "agent", title: tab?.title || "", url: tab?.url || "" });
  return { tabId: id };
}

async function closeWindow(windowId) {
  const id = Number(windowId);
  if (!Number.isFinite(id)) throw new Error("windowId required");
  await chrome.windows.remove(id);
  await sendTabs(true);
  await queueHistory("WINDOW_CLOSED_BY_DASHBOARD", { source: "agent", extra: { windowId: id } });
  return { windowId: id };
}

async function openUrl(url) {
  let u = String(url || "").trim();
  if (!u) throw new Error("URL required");
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  await chrome.tabs.create({ url: u });
  await sendTabs(true);
  await queueHistory("URL_OPENED_BY_DASHBOARD", { source: "agent", url: u });
  return { url: u };
}

async function messageAll(text) {
  const msg = String(text || "");
  const tabs = await chrome.tabs.query({});
  let sent = 0;
  for (const tab of tabs) {
    if (tab.id && /^https?:\/\//i.test(tab.url || "")) {
      chrome.tabs.sendMessage(tab.id, { type: "SHOW_MESSAGE", text: msg }).catch(() => {});
      sent++;
    }
  }
  await queueHistory("MESSAGE_SENT", { source: "agent", extra: { sent, text: msg } });
  return { sent };
}

async function closeOfftaskTabs() {
  const allowed = (currentSettings.allowDomains || []).map(normalizeDomain).filter(Boolean);
  const tabs = await chrome.tabs.query({});
  let closed = 0;

  for (const tab of tabs) {
    if (!tab.id || !/^https?:\/\//i.test(tab.url || "")) continue;
    const host = new URL(tab.url).hostname.replace(/^www\./, "");
    const ok = allowed.some(d => host === d || host.endsWith("." + d));
    if (!ok) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      closed++;
    }
  }

  await sendTabs(true);
  await queueHistory("OFFTASK_TABS_CLOSED", { source: "agent", extra: { closed } });
  return { closed };
}

async function enforceTabLimit() {
  const limit = Number(currentSettings.tabLimit || 0);
  if (!currentSettings.enabled || limit <= 0) return;

  const tabs = (await chrome.tabs.query({})).filter(t => t.id && /^https?:\/\//i.test(t.url || ""));
  if (tabs.length <= limit) return;

  const extra = tabs.slice(0, tabs.length - limit);
  for (const tab of extra) await chrome.tabs.remove(tab.id).catch(() => {});
  await sendTabs(true);
  await queueHistory("TAB_LIMIT_ENFORCED", { source: "agent", extra: { closed: extra.length, limit } });
}

async function inspectTab(tab, eventType) {
  if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) return;

  await queueHistory(eventType, {
    source: "agent",
    title: tab.title || "",
    url: tab.url || ""
  });

  const hay = `${tab.title || ""} ${tab.url || ""}`.toLowerCase();
  const hit = (currentSettings.alertKeywords || []).find(k => k && hay.includes(String(k).toLowerCase()));

  if (hit) {
    send({
      type: "log",
      level: "alert",
      eventType: "ALERT_KEYWORD",
      title: tab.title || "",
      url: tab.url || "",
      source: "agent",
      extra: { keyword: hit }
    });

    await queueHistory("ALERT_KEYWORD", {
      source: "agent",
      status: "ALERT",
      title: tab.title || "",
      url: tab.url || "",
      extra: { keyword: hit }
    });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "PAGE_VISIT") {
      await queueHistory("PAGE_VISIT", {
        source: "content",
        title: msg.title || "",
        url: msg.url || ""
      });
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: "Unknown message type" });
  })().catch(err => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

async function queueHistory(eventType, fields = {}) {
  if (!CONFIG.HISTORY.ENABLED) return;

  const log = {
    deviceId: CONFIG.DEVICE_ID,
    deviceName: CONFIG.DEVICE_NAME,
    eventType,
    title: fields.title || "",
    url: fields.url || "",
    command: fields.command || "",
    status: fields.status || "OK",
    source: fields.source || "agent",
    extra: fields.extra || {}
  };

  const sent = send({ type: "history", logs: [log] });
  if (sent) return;

  const stored = await chrome.storage.local.get("historyQueue");
  const q = [...(stored.historyQueue || []), log].slice(-1000);
  await chrome.storage.local.set({ historyQueue: q });
}

async function flushHistory() {
  if (!CONFIG.HISTORY.ENABLED) return;

  const stored = await chrome.storage.local.get("historyQueue");
  const q = stored.historyQueue || [];
  if (!q.length) return;

  if (send({ type: "history", logs: q.slice(0, CONFIG.HISTORY.BATCH_SIZE || 10) })) {
    await chrome.storage.local.set({ historyQueue: q.slice(CONFIG.HISTORY.BATCH_SIZE || 10) });
    return;
  }

  try {
    const batch = q.slice(0, CONFIG.HISTORY.BATCH_SIZE || 10);
    const res = await fetch(apiUrl("/api/logs"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${CONFIG.API_KEY}`
      },
      body: JSON.stringify({ logs: batch })
    });

    if (res.ok) {
      await chrome.storage.local.set({ historyQueue: q.slice(CONFIG.HISTORY.BATCH_SIZE || 10) });
    }
  } catch (_) {}
}

connect();

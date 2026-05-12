const HISTORY_RETENTION_DAYS = 60;
const MAX_HISTORY_LIMIT = 500;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "Brick Classroom Cloudflare D1",
        d1: !!env.DB,
        websocket: "/ws/:roomId",
        historyRetentionDays: HISTORY_RETENTION_DAYS,
        time: new Date().toISOString()
      });
    }

    if (url.pathname.startsWith("/ws/")) {
      if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      const roomId = decodeURIComponent(url.pathname.replace("/ws/", "")).trim();
      if (!roomId) return json({ ok: false, error: "roomId required" }, 400);
      const id = env.ROOMS.idFromName(roomId);
      return env.ROOMS.get(id).fetch(request);
    }

    if (url.pathname === "/api/history" && request.method === "GET") {
      if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      return handleGetHistory(request, env);
    }

    if (url.pathname === "/api/devices" && request.method === "GET") {
      if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      return handleGetDevices(env);
    }

    if (url.pathname === "/api/logs" && request.method === "POST") {
      if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      return handlePostLogs(request, env);
    }

    if (url.pathname === "/api/cleanup" && request.method === "POST") {
      if (!authorized(request, env)) return json({ ok: false, error: "Unauthorized" }, 401);
      const result = await cleanupOldHistory(env);
      return json({ ok: true, ...result });
    }

    if (request.method === "OPTIONS") return corsResponse();

    return json({ ok: false, error: "Not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupOldHistory(env));
  }
};

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();

    if (this.state.getWebSockets) {
      for (const ws of this.state.getWebSockets()) {
        const meta = ws.deserializeAttachment?.() || {};
        this.sessions.set(ws, meta);
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") || "unknown";
    const deviceId = url.searchParams.get("deviceId") || "";
    const deviceName = url.searchParams.get("deviceName") || deviceId || "";

    if (request.headers.get("Upgrade") !== "websocket") {
      return json({ ok: false, error: "Expected WebSocket upgrade" }, 426);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const meta = {
      id: crypto.randomUUID(),
      role,
      deviceId,
      deviceName,
      connectedAt: Date.now()
    };

    if (this.state.acceptWebSocket) {
      this.state.acceptWebSocket(server);
      server.serializeAttachment?.(meta);
    } else {
      server.accept();
      server.addEventListener("message", event => this.handleMessage(server, event.data));
      server.addEventListener("close", () => this.handleClose(server));
      server.addEventListener("error", () => this.handleClose(server));
    }

    this.sessions.set(server, meta);

    if (role === "agent" && deviceId) {
      await upsertDevice(this.env, {
        deviceId,
        deviceName,
        status: "online",
        liveOn: 0,
        extra: { role, connectedAt: meta.connectedAt }
      });
      await insertHistory(this.env, {
        device_id: deviceId,
        device_name: deviceName,
        event_type: "DEVICE_ONLINE",
        status: "OK",
        source: "worker",
        extra_json: JSON.stringify({ room: this.roomIdFromRequest(request) })
      });
    }

    this.send(server, {
      type: "joined",
      self: meta,
      peers: this.peerList(),
      time: Date.now()
    });

    this.broadcast(server, {
      type: "peer-joined",
      peer: meta,
      peers: this.peerList(),
      time: Date.now()
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    await this.handleMessage(ws, message);
  }

  async webSocketClose(ws) {
    await this.handleClose(ws);
  }

  async webSocketError(ws) {
    await this.handleClose(ws);
  }

  async handleMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      this.send(ws, { type: "error", error: "Invalid JSON" });
      return;
    }

    const from = this.sessions.get(ws) || ws.deserializeAttachment?.() || {};

    if (msg.type === "presence") {
      this.send(ws, { type: "presence", peers: this.peerList(), time: Date.now() });
      return;
    }

    if (msg.type === "hello") {
      this.broadcast(ws, { ...msg, from, time: Date.now() });
      return;
    }

    if (msg.type === "command") {
      await insertHistory(this.env, {
        device_id: msg.targetDeviceId || "broadcast",
        device_name: "",
        event_type: "COMMAND_SENT",
        command: msg.command?.type || "",
        status: "SENT",
        source: "dashboard",
        extra_json: JSON.stringify({ id: msg.id || "", payload: msg.command?.payload || {} })
      });
      this.broadcast(ws, { ...msg, from, time: Date.now() });
      return;
    }

    if (msg.type === "command-result") {
      await insertHistory(this.env, {
        device_id: from.deviceId || msg.deviceId || "unknown",
        device_name: from.deviceName || "",
        event_type: "COMMAND_RESULT",
        command: msg.command || msg.commandType || "",
        status: msg.ok ? "OK" : "ERROR",
        source: "agent",
        extra_json: JSON.stringify({ id: msg.id || "", result: msg.result || null, error: msg.error || null })
      });
      this.broadcast(ws, { ...msg, from, time: Date.now() });
      return;
    }

    if (msg.type === "status") {
      if (from.deviceId) {
        await upsertDevice(this.env, {
          deviceId: from.deviceId,
          deviceName: from.deviceName,
          status: msg.text || "online",
          liveOn: msg.liveOn ? 1 : 0,
          currentTitle: msg.extra?.title || "",
          currentUrl: msg.extra?.url || "",
          extra: msg.extra || {}
        });
      }
      this.broadcast(ws, { ...msg, from, time: Date.now() });
      return;
    }

    if (msg.type === "tabs" || msg.type === "frame" || msg.type === "log") {
      this.broadcast(ws, { ...msg, from, time: Date.now() });

      if (msg.type === "log") {
        await insertHistory(this.env, {
          device_id: from.deviceId || msg.deviceId || "unknown",
          device_name: from.deviceName || "",
          event_type: msg.eventType || "LOG",
          title: msg.title || msg.tab?.title || "",
          url: msg.url || msg.tab?.url || "",
          status: msg.level || "INFO",
          source: msg.source || "agent",
          extra_json: JSON.stringify(msg.extra || msg)
        });
      }
      return;
    }

    if (msg.type === "history") {
      const logs = Array.isArray(msg.logs) ? msg.logs : [msg.log || msg];
      await insertLogs(this.env, logs.map(log => ({
        device_id: log.deviceId || from.deviceId || "unknown",
        device_name: log.deviceName || from.deviceName || "",
        event_type: log.eventType || "EVENT",
        title: log.title || "",
        url: log.url || "",
        command: log.command || "",
        status: log.status || "OK",
        source: log.source || "agent",
        extra_json: JSON.stringify(log.extra || {})
      })));
      return;
    }

    this.send(ws, { type: "error", error: "Unknown message type", got: msg.type });
  }

  async handleClose(ws) {
    const old = this.sessions.get(ws) || ws.deserializeAttachment?.() || {};
    this.sessions.delete(ws);

    if (old.role === "agent" && old.deviceId) {
      await upsertDevice(this.env, {
        deviceId: old.deviceId,
        deviceName: old.deviceName,
        status: "offline",
        liveOn: 0,
        extra: { disconnectedAt: Date.now() }
      });
      await insertHistory(this.env, {
        device_id: old.deviceId,
        device_name: old.deviceName || "",
        event_type: "DEVICE_OFFLINE",
        status: "OK",
        source: "worker"
      });
    }

    this.broadcast(ws, {
      type: "peer-left",
      peer: old,
      peers: this.peerList(),
      time: Date.now()
    });
  }

  peerList() {
    return [...this.sessions.values()].map(p => ({
      id: p.id,
      role: p.role,
      deviceId: p.deviceId,
      deviceName: p.deviceName,
      connectedAt: p.connectedAt
    }));
  }

  roomIdFromRequest(request) {
    const url = new URL(request.url);
    return decodeURIComponent(url.pathname.replace("/ws/", ""));
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }

  broadcast(sender, obj) {
    for (const ws of this.sessions.keys()) {
      if (ws !== sender) this.send(ws, obj);
    }
  }
}

async function handleGetHistory(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || 100), MAX_HISTORY_LIMIT);
  const deviceId = url.searchParams.get("deviceId") || "";
  const eventType = url.searchParams.get("eventType") || "";
  const q = url.searchParams.get("q") || "";

  const where = [];
  const params = [];

  if (deviceId) {
    where.push("device_id = ?");
    params.push(deviceId);
  }
  if (eventType) {
    where.push("event_type = ?");
    params.push(eventType);
  }
  if (q) {
    where.push("(title LIKE ? OR url LIKE ? OR event_type LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const sql = `
    SELECT id, created_at, device_id, device_name, event_type, title, url, command, status, source, extra_json
    FROM history_logs
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY created_at DESC
    LIMIT ?
  `;

  params.push(limit);
  const result = await env.DB.prepare(sql).bind(...params).all();
  return json({ ok: true, rows: result.results || [], limit });
}

async function handleGetDevices(env) {
  const result = await env.DB.prepare(`
    SELECT device_id, device_name, status, live_on, current_title, current_url, last_seen, extra_json
    FROM devices
    ORDER BY last_seen DESC
  `).all();
  return json({ ok: true, devices: result.results || [] });
}

async function handlePostLogs(request, env) {
  const body = await request.json().catch(() => ({}));
  const logs = Array.isArray(body.logs) ? body.logs : [];
  await insertLogs(env, logs.map(log => ({
    device_id: log.deviceId || log.device_id || "unknown",
    device_name: log.deviceName || log.device_name || "",
    event_type: log.eventType || log.event_type || "EVENT",
    title: log.title || "",
    url: log.url || "",
    command: log.command || "",
    status: log.status || "OK",
    source: log.source || "agent",
    extra_json: JSON.stringify(log.extra || {})
  })));
  return json({ ok: true, inserted: logs.length });
}

async function insertLogs(env, logs) {
  if (!logs.length) return;
  const stmt = env.DB.prepare(`
    INSERT INTO history_logs
    (created_at, device_id, device_name, event_type, title, url, command, status, source, extra_json)
    VALUES (datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  await env.DB.batch(logs.map(log => stmt.bind(
    log.device_id || "unknown",
    log.device_name || "",
    log.event_type || "EVENT",
    log.title || "",
    log.url || "",
    log.command || "",
    log.status || "OK",
    log.source || "",
    log.extra_json || "{}"
  )));
}

async function insertHistory(env, log) {
  await insertLogs(env, [log]);
}

async function upsertDevice(env, device) {
  await env.DB.prepare(`
    INSERT INTO devices
    (device_id, device_name, status, live_on, current_title, current_url, last_seen, extra_json)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
    ON CONFLICT(device_id) DO UPDATE SET
      device_name = excluded.device_name,
      status = excluded.status,
      live_on = excluded.live_on,
      current_title = excluded.current_title,
      current_url = excluded.current_url,
      last_seen = datetime('now'),
      extra_json = excluded.extra_json
  `).bind(
    device.deviceId,
    device.deviceName || device.deviceId,
    device.status || "online",
    Number(device.liveOn || 0),
    device.currentTitle || "",
    device.currentUrl || "",
    JSON.stringify(device.extra || {})
  ).run();
}

async function cleanupOldHistory(env) {
  const result = await env.DB.prepare(`
    DELETE FROM history_logs
    WHERE created_at < datetime('now', '-${HISTORY_RETENTION_DAYS} days')
  `).run();
  return {
    retentionDays: HISTORY_RETENTION_DAYS,
    deleted: result.meta?.changes || 0,
    time: new Date().toISOString()
  };
}

function authorized(request, env) {
  const url = new URL(request.url);
  const bearer = request.headers.get("Authorization") || "";
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
  const key = url.searchParams.get("key") || token;
  return !!env.BRICK_API_KEY && key === env.BRICK_API_KEY;
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-max-age": "86400"
  };
}

function corsResponse() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
}

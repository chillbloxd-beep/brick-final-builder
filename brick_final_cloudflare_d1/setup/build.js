import fs from "fs";
import path from "path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SETUP = path.join(ROOT, "setup");
const OUT = path.join(ROOT, "output");
const EXT_SRC = path.join(ROOT, "extension");
const DASH_SRC = path.join(ROOT, "dashboard-github-pages");

const configPath = path.join(SETUP, "setup-config.json");
const examplePath = path.join(SETUP, "setup-config.example.json");

if (!fs.existsSync(configPath)) {
  fs.copyFileSync(examplePath, configPath);
  console.log("Created setup/setup-config.json from example. Edit it, then rerun: node setup/build.js");
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const devices = readCsv(path.join(SETUP, "devices.csv"));

rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

// Dashboard
const dashOut = path.join(OUT, "dashboard-ready");
copyDir(DASH_SRC, dashOut);
writeDashboardConfig(path.join(dashOut, "config.js"), config);

// Extensions
const extReadyRoot = path.join(OUT, "extension-ready");
fs.mkdirSync(extReadyRoot, { recursive: true });

for (const device of devices) {
  const folder = path.join(extReadyRoot, safeName(device.deviceId));
  copyDir(EXT_SRC, folder);
  writeExtensionConfig(path.join(folder, "config.js"), config, device);
}

console.log("Generated:");
console.log(" - output/dashboard-ready/");
for (const device of devices) console.log(` - output/extension-ready/${safeName(device.deviceId)}/`);

function writeDashboardConfig(file, c) {
  const js = `export const DASHBOARD_CONFIG = ${JSON.stringify({
    WORKER_BASE_URL: c.cloudflare.workerBaseUrl,
    ROOM_ID: c.cloudflare.roomId,
    API_KEY: c.cloudflare.apiKey,
    UI: {
      AUTO_CONNECT: c.dashboard.autoConnect,
      AUTO_REFRESH_TABS: c.dashboard.autoRefreshTabs,
      TAB_REFRESH_MS: c.dashboard.tabRefreshMs,
      HISTORY_LIMIT: c.dashboard.historyLimit
    },
    LIVE: {
      DEFAULT_FPS: c.live.defaultFps
    },
    DEFAULT_RULES: {
      allowDomains: c.rules.allowDomains,
      blockDomains: c.rules.blockDomains,
      blockKeywords: c.rules.blockKeywords,
      alertKeywords: c.rules.alertKeywords,
      tabLimit: c.rules.tabLimit
    }
  }, null, 2)};\n`;
  fs.writeFileSync(file, js);
}

function writeExtensionConfig(file, c, device) {
  const js = `export const CONFIG = ${JSON.stringify({
    WORKER_BASE_URL: c.cloudflare.workerBaseUrl,
    ROOM_ID: c.cloudflare.roomId,
    API_KEY: c.cloudflare.apiKey,
    DEVICE_ID: device.deviceId,
    DEVICE_NAME: device.deviceName || device.deviceId,
    LIVE: {
      MAX_SCREENSHOT_FPS: Math.min(c.live.defaultFps || 2, 2),
      JPEG_QUALITY: c.live.jpegQuality || 45,
      SHOW_LIVE_BADGE: true
    },
    HISTORY: {
      ENABLED: true,
      BATCH_SIZE: 10,
      FLUSH_EVERY_SECONDS: 20
    },
    RULES: {
      TAB_LIMIT: c.rules.tabLimit || 0,
      DEFAULT_ALLOW_DOMAINS: c.rules.allowDomains,
      DEFAULT_BLOCK_DOMAINS: c.rules.blockDomains,
      DEFAULT_BLOCK_KEYWORDS: c.rules.blockKeywords,
      DEFAULT_ALERT_KEYWORDS: c.rules.alertKeywords
    }
  }, null, 2)};\n`;
  fs.writeFileSync(file, js);
}

function readCsv(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  const [head, ...lines] = text.split(/\r?\n/);
  const headers = head.split(",").map(x => x.trim());
  return lines.filter(Boolean).map(line => {
    const values = line.split(",").map(x => x.trim());
    const obj = {};
    headers.forEach((h, i) => obj[h] = values[i] || "");
    return obj;
  });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, "_");
}

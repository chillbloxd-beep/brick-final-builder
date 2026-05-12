export const CONFIG = {
  WORKER_BASE_URL: "https://YOUR-WORKER.workers.dev",
  ROOM_ID: "brick-room-001",
  API_KEY: "CHANGE_ME_TO_THE_SAME_BRICK_API_KEY",
  DEVICE_ID: "student-device-01",
  DEVICE_NAME: "Student Device 01",

  LIVE: {
    // Dashboard-controlled screenshot mode. Chrome hard-limits captureVisibleTab to 2 calls/sec.
    MAX_SCREENSHOT_FPS: 2,
    JPEG_QUALITY: 45,
    SHOW_LIVE_BADGE: true
  },

  HISTORY: {
    ENABLED: true,
    BATCH_SIZE: 10,
    FLUSH_EVERY_SECONDS: 20
  },

  RULES: {
    TAB_LIMIT: 0,
    DEFAULT_ALLOW_DOMAINS: [
      "google.com",
      "docs.google.com",
      "classroom.google.com",
      "wikipedia.org",
      "khanacademy.org"
    ],
    DEFAULT_BLOCK_DOMAINS: [
      "youtube.com",
      "discord.com",
      "roblox.com",
      "crazygames.com",
      "tiktok.com"
    ],
    DEFAULT_BLOCK_KEYWORDS: [
      "proxy",
      "vpn",
      "games",
      "casino",
      "cheat"
    ],
    DEFAULT_ALERT_KEYWORDS: [
      "proxy",
      "vpn",
      "game",
      "cheat",
      "discord",
      "roblox"
    ]
  }
};

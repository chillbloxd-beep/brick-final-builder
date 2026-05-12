export const DASHBOARD_CONFIG = {
  WORKER_BASE_URL: "https://YOUR-WORKER.workers.dev",
  ROOM_ID: "brick-room-001",
  API_KEY: "CHANGE_ME_TO_THE_SAME_BRICK_API_KEY",

  UI: {
    AUTO_CONNECT: true,
    AUTO_REFRESH_TABS: true,
    TAB_REFRESH_MS: 2500,
    HISTORY_LIMIT: 150
  },

  LIVE: {
    DEFAULT_FPS: 2
  },

  DEFAULT_RULES: {
    allowDomains: [
      "google.com",
      "docs.google.com",
      "classroom.google.com",
      "wikipedia.org",
      "khanacademy.org"
    ],
    blockDomains: [
      "youtube.com",
      "discord.com",
      "roblox.com",
      "crazygames.com",
      "tiktok.com"
    ],
    blockKeywords: [
      "proxy",
      "vpn",
      "games",
      "casino",
      "cheat"
    ],
    alertKeywords: [
      "proxy",
      "vpn",
      "game",
      "cheat",
      "discord",
      "roblox"
    ],
    tabLimit: 0
  }
};

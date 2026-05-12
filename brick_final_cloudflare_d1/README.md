# Brick Final Cloudflare D1 Bundle

Compatible with:
- GitHub Pages for dashboard
- Cloudflare Workers
- Cloudflare Durable Objects
- Cloudflare D1

## Features included

- No student popup UI
- No student settings page
- Dashboard-controlled live preview
- Reset Live Feed
- Hard Reconnect
- Start/Stop live preview
- All-tabs dashboard
- Activate tab
- Close tab
- Close window
- Send/open link
- Send message overlay
- Focus mode
- Lock browsing
- Allow/block rules
- Block URL keywords
- Alert keywords
- Close off-task tabs
- Tab limit
- Cloudflare D1 history logging
- History UI inside GitHub Pages dashboard
- CSV export
- Manual cleanup button
- Automatic 60-day history deletion using Cloudflare Cron Trigger
- Setup folder that generates preconfigured extension/dashboard folders

## Important live preview note

This dashboard-controlled version uses `chrome.tabs.captureVisibleTab()`.
Chrome limits that API to 2 captures per second, so this version intentionally caps live preview at 2fps.

## Setup summary

1. Deploy Cloudflare Worker and D1:
   - `cd cloudflare-worker-d1`
   - `npm install`
   - `npx wrangler d1 create brick_history`
   - paste database_id into `wrangler.toml`
   - change `BRICK_API_KEY`
   - `npm run schema:remote`
   - `npm run deploy`

2. Edit setup config:
   - copy `setup/setup-config.example.json` to `setup/setup-config.json`
   - set Worker URL and API key
   - edit `setup/devices.csv`

3. Generate ready folders:
   - `node setup/build.js`

4. GitHub Pages:
   - upload `output/dashboard-ready/`

5. Student devices:
   - load unpacked `output/extension-ready/<deviceId>/`

## History retention

History rows older than 60 days are deleted automatically daily by the Cloudflare Worker scheduled handler.

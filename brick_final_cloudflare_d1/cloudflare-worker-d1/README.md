# Brick Cloudflare Worker + D1

## Deploy

```bash
npm install
npx wrangler login
```

Create D1 database:

```bash
npx wrangler d1 create brick_history
```

Paste the generated `database_id` into `wrangler.toml`.

Change:

```toml
BRICK_API_KEY = "CHANGE_ME_TO_A_LONG_RANDOM_SECRET"
```

Apply schema:

```bash
npm run schema:remote
```

Deploy:

```bash
npm run deploy
```

Test:

```txt
https://YOUR-WORKER.workers.dev/health
```

## 60-day cleanup

This project has a Cron Trigger:

```toml
[triggers]
crons = ["0 0 * * *"]
```

The Worker deletes D1 history rows older than 60 days once per day.

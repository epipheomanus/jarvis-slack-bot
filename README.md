# Jarvis Slack Bot

Epipheo's Slack bot for the **#jarvis-marketing** channel. Jarvis listens for approval/hold/feedback messages and updates a linked Google Doc automatically. Also supports **LinkedIn company page posting** via the Epipheo Page Manager app.

## Features

- **Approval workflow** — detects keywords like "approved", "lgtm", "ship it" and marks the Google Doc as *Approved*
- **Hold workflow** — detects keywords like "hold", "wait", "pause" and marks the Google Doc as *On Hold*
- **Feedback capture** — any other message is acknowledged as feedback
- **Google Doc sync** — automatically updates the Status line in the linked Google Doc
- **LinkedIn company page posting** — post text, images, and videos to the Epipheo LinkedIn company page
- **Organization lookup** — look up LinkedIn organization URN by vanity name
- **Image/Video upload** — upload media to LinkedIn for rich company page posts
- **Health check** — `GET /health` returns uptime and status

## Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check with uptime and LinkedIn status |
| `/slack/events` | POST | Slack Event Subscriptions handler |
| `/linkedin/auth` | GET | Start LinkedIn OAuth flow (Epipheo Page Manager app) |
| `/linkedin/callback` | GET | OAuth callback handler |
| `/linkedin/status` | GET | Check LinkedIn connection status |
| `/linkedin/org-lookup?vanityName=epipheo` | GET | Look up organization URN by vanity name |
| `/linkedin/org-admin-list` | GET | List organizations you administer |
| `/linkedin/post-company` | POST | Post to a LinkedIn company page |
| `/linkedin/upload-image` | POST | Upload an image for a company page post |
| `/linkedin/upload-video` | POST | Upload a video for a company page post |
| `/linkedin/post` | POST | Legacy: post to LinkedIn (backward compatible) |
| `/linkedin/tokens` | GET | Internal: retrieve stored tokens (requires x-jarvis-key header) |

## LinkedIn Company Page Posting

### 1. Authorize the app

Visit `https://jarvis-slack-bot-production.up.railway.app/linkedin/auth` to authorize the Epipheo Page Manager app. You must be an admin of the Epipheo LinkedIn company page.

### 2. Look up the organization ID

```bash
curl https://jarvis-slack-bot-production.up.railway.app/linkedin/org-lookup?vanityName=epipheo
```

### 3. Post a text update

```bash
curl -X POST https://jarvis-slack-bot-production.up.railway.app/linkedin/post-company \
  -H "Content-Type: application/json" \
  -d '{"orgId": "YOUR_ORG_ID", "text": "Hello from Jarvis!"}'
```

### 4. Post with an image

```bash
# Step 1: Upload the image
curl -X POST https://jarvis-slack-bot-production.up.railway.app/linkedin/upload-image \
  -H "Content-Type: application/json" \
  -d '{"orgId": "YOUR_ORG_ID", "imageUrl": "https://example.com/image.jpg"}'

# Step 2: Use the returned imageUrn in the post
curl -X POST https://jarvis-slack-bot-production.up.railway.app/linkedin/post-company \
  -H "Content-Type: application/json" \
  -d '{"orgId": "YOUR_ORG_ID", "text": "Check out this image!", "imageUrn": "urn:li:image:XXXXX"}'
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (Railway sets this automatically) |
| `SLACK_BOT_TOKEN` | Yes | Slack Bot User OAuth Token (`xoxb-…`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | No | Full JSON string of a Google service account key (for Doc updates) |
| `LINKEDIN_CLIENT_ID` | Yes | LinkedIn app Client ID (Epipheo Page Manager) |
| `LINKEDIN_CLIENT_SECRET` | Yes | LinkedIn app Client Secret |
| `LINKEDIN_REDIRECT_URI` | No | OAuth redirect URI (defaults to Railway production URL) |
| `LINKEDIN_ACCESS_TOKEN` | No | Pre-stored access token (set after OAuth flow) |
| `LINKEDIN_REFRESH_TOKEN` | No | Pre-stored refresh token (set after OAuth flow) |
| `LINKEDIN_EXPIRES_AT` | No | Token expiry timestamp in ms |

## Deployment (Railway)

1. Connect this GitHub repo to a new Railway project
2. Set the environment variables above in Railway's dashboard
3. Railway will auto-detect the Dockerfile and deploy
4. Use the generated Railway URL as your Slack Event Subscriptions Request URL: `https://<your-app>.up.railway.app/slack/events`

## Local Development

```bash
npm install
SLACK_BOT_TOKEN=xoxb-... LINKEDIN_CLIENT_ID=... LINKEDIN_CLIENT_SECRET=... PORT=3000 node index.js
```

---

*All bot messages are signed* **— Jarvis**

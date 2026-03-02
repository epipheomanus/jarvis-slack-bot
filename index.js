const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

// ─── Configuration ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON; // JSON string
const GOOGLE_DOC_ID = "1QDR2OwIg5vKWy0mKthaOi0pJo46dY_4eMRhVEujhpUk";

// LinkedIn OAuth config
const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const LINKEDIN_REDIRECT_URI = process.env.LINKEDIN_REDIRECT_URI || "https://jarvis-slack-bot-production.up.railway.app/linkedin/callback";
const LINKEDIN_SCOPES = "openid profile email w_member_social";

// In-memory token store (also persisted to env-friendly log)
let linkedinTokens = {
  access_token: process.env.LINKEDIN_ACCESS_TOKEN || null,
  refresh_token: process.env.LINKEDIN_REFRESH_TOKEN || null,
  expires_at: process.env.LINKEDIN_EXPIRES_AT ? parseInt(process.env.LINKEDIN_EXPIRES_AT) : null,
};

// Approval / hold keyword lists (lowercase)
const APPROVAL_KEYWORDS = ["approved", "approve", "looks good", "lgtm", "go ahead", "ship it"];
const HOLD_KEYWORDS = ["hold", "skip", "wait", "pause", "not yet"];

const SIGNATURE = "\n\n— Jarvis";

// ─── Google Docs helper ──────────────────────────────────────────────────────
let docsClient = null;

function getDocsClient() {
  if (docsClient) return docsClient;
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.warn("⚠️  GOOGLE_SERVICE_ACCOUNT_JSON not set – Google Doc updates disabled.");
    return null;
  }
  try {
    const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/documents"],
    });
    docsClient = google.docs({ version: "v1", auth });
    return docsClient;
  } catch (err) {
    console.error("Failed to initialize Google Docs client:", err.message);
    return null;
  }
}

async function updateDocStatus(newStatus) {
  const docs = getDocsClient();
  if (!docs) {
    console.log(`[Google Doc] Would set status to "${newStatus}" but Docs client is unavailable.`);
    return;
  }

  try {
    // Read the document to find the status line
    const doc = await docs.documents.get({ documentId: GOOGLE_DOC_ID });
    const body = doc.data.body.content;

    let statusStart = null;
    let statusEnd = null;

    // Walk through all structural elements looking for "Status:" text
    for (const element of body) {
      if (element.paragraph && element.paragraph.elements) {
        for (const el of element.paragraph.elements) {
          if (el.textRun && el.textRun.content) {
            const text = el.textRun.content;
            const idx = text.toLowerCase().indexOf("status:");
            if (idx !== -1) {
              // Found the status line – replace from "Status:" to end of that text run
              statusStart = el.startIndex + idx;
              statusEnd = el.endIndex;
              break;
            }
          }
        }
      }
      if (statusStart !== null) break;
    }

    if (statusStart !== null && statusEnd !== null) {
      // Replace the existing status line
      const replacement = `Status: ${newStatus}\n`;
      await docs.documents.batchUpdate({
        documentId: GOOGLE_DOC_ID,
        requestBody: {
          requests: [
            { deleteContentRange: { range: { startIndex: statusStart, endIndex: statusEnd } } },
            { insertText: { location: { index: statusStart }, text: replacement } },
          ],
        },
      });
      console.log(`[Google Doc] Status updated to "${newStatus}".`);
    } else {
      // No status line found – append one at the end of the document
      const endIndex = doc.data.body.content[doc.data.body.content.length - 1].endIndex - 1;
      await docs.documents.batchUpdate({
        documentId: GOOGLE_DOC_ID,
        requestBody: {
          requests: [
            { insertText: { location: { index: endIndex }, text: `\nStatus: ${newStatus}\n` } },
          ],
        },
      });
      console.log(`[Google Doc] Appended status "${newStatus}" (no existing status line found).`);
    }
  } catch (err) {
    console.error("[Google Doc] Error updating status:", err.message);
  }
}

// ─── Slack helper ────────────────────────────────────────────────────────────
async function postSlackMessage(channel, text) {
  try {
    await axios.post(
      "https://slack.com/api/chat.postMessage",
      { channel, text: text + SIGNATURE },
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[Slack] Error posting message:", err.message);
  }
}

// ─── Classify message ────────────────────────────────────────────────────────
function classifyMessage(text) {
  const lower = text.toLowerCase();
  for (const kw of APPROVAL_KEYWORDS) {
    if (lower.includes(kw)) return "approved";
  }
  for (const kw of HOLD_KEYWORDS) {
    if (lower.includes(kw)) return "hold";
  }
  return "feedback";
}

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    bot: "Jarvis",
    uptime: process.uptime(),
    linkedin_connected: !!linkedinTokens.access_token,
  });
});

// Root route
app.get("/", (_req, res) => {
  res.json({
    message: "Jarvis Slack Bot is running.",
    endpoints: {
      slack_events: "POST /slack/events",
      linkedin_auth: "GET /linkedin/auth",
      linkedin_callback: "GET /linkedin/callback",
      linkedin_status: "GET /linkedin/status",
      linkedin_post: "POST /linkedin/post",
      health: "GET /health",
    },
  });
});

// ─── LinkedIn OAuth ─────────────────────────────────────────────────────────

// Step 1: Redirect user to LinkedIn authorization page
app.get("/linkedin/auth", (_req, res) => {
  const state = Math.random().toString(36).substring(2, 15);
  const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${LINKEDIN_CLIENT_ID}&redirect_uri=${encodeURIComponent(LINKEDIN_REDIRECT_URI)}&scope=${encodeURIComponent(LINKEDIN_SCOPES)}&state=${state}`;
  console.log("[LinkedIn] Redirecting to authorization URL.");
  res.redirect(authUrl);
});

// Step 2: Handle OAuth callback
app.get("/linkedin/callback", async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    console.error(`[LinkedIn] OAuth error: ${error} — ${error_description}`);
    return res.status(400).send(`<h1>LinkedIn Authorization Failed</h1><p>${error}: ${error_description}</p>`);
  }

  if (!code) {
    return res.status(400).send("<h1>Missing authorization code</h1>");
  }

  try {
    // Exchange code for access token
    const tokenResponse = await axios.post(
      "https://www.linkedin.com/oauth/v2/accessToken",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: LINKEDIN_REDIRECT_URI,
        client_id: LINKEDIN_CLIENT_ID,
        client_secret: LINKEDIN_CLIENT_SECRET,
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const { access_token, expires_in, refresh_token, refresh_token_expires_in } = tokenResponse.data;

    linkedinTokens = {
      access_token,
      refresh_token: refresh_token || null,
      expires_at: Date.now() + expires_in * 1000,
      refresh_token_expires_at: refresh_token_expires_in
        ? Date.now() + refresh_token_expires_in * 1000
        : null,
    };

    console.log(`[LinkedIn] Authorization successful. Token expires in ${expires_in}s.`);
    if (refresh_token) {
      console.log(`[LinkedIn] Refresh token received. Expires in ${refresh_token_expires_in}s.`);
    }

    // Get user profile to confirm identity
    let profileName = "Unknown";
    try {
      const profileRes = await axios.get("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      profileName = profileRes.data.name || profileRes.data.email || "Unknown";
      linkedinTokens.profile_name = profileName;
      linkedinTokens.profile_sub = profileRes.data.sub;
    } catch (profileErr) {
      console.warn("[LinkedIn] Could not fetch profile:", profileErr.message);
    }

    res.send(`
      <html>
      <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 80px auto; text-align: center;">
        <h1 style="color: #0A66C2;">✅ LinkedIn Connected!</h1>
        <p>Authorized as: <strong>${profileName}</strong></p>
        <p>Access token expires: <strong>${new Date(linkedinTokens.expires_at).toLocaleString()}</strong></p>
        ${refresh_token ? '<p>Refresh token: ✅ Received (auto-renewal enabled)</p>' : '<p>Refresh token: ❌ Not provided (will need to re-authorize when token expires)</p>'}
        <hr>
        <p style="color: #666;">You can close this window. Jarvis can now post to LinkedIn on your behalf.</p>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("[LinkedIn] Token exchange error:", err.response?.data || err.message);
    res.status(500).send(`<h1>Token Exchange Failed</h1><pre>${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>`);
  }
});

// Status check
app.get("/linkedin/status", (_req, res) => {
  if (!linkedinTokens.access_token) {
    return res.json({
      connected: false,
      message: "Not connected. Visit /linkedin/auth to authorize.",
    });
  }

  const expired = linkedinTokens.expires_at && Date.now() > linkedinTokens.expires_at;
  res.json({
    connected: true,
    expired,
    profile_name: linkedinTokens.profile_name || null,
    expires_at: linkedinTokens.expires_at ? new Date(linkedinTokens.expires_at).toISOString() : null,
    has_refresh_token: !!linkedinTokens.refresh_token,
  });
});

// Post to LinkedIn (company page or personal)
app.post("/linkedin/post", async (req, res) => {
  if (!linkedinTokens.access_token) {
    return res.status(401).json({ error: "Not authorized. Visit /linkedin/auth first." });
  }

  // Auto-refresh if expired and we have a refresh token
  if (linkedinTokens.expires_at && Date.now() > linkedinTokens.expires_at && linkedinTokens.refresh_token) {
    try {
      const refreshRes = await axios.post(
        "https://www.linkedin.com/oauth/v2/accessToken",
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: linkedinTokens.refresh_token,
          client_id: LINKEDIN_CLIENT_ID,
          client_secret: LINKEDIN_CLIENT_SECRET,
        }).toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
      linkedinTokens.access_token = refreshRes.data.access_token;
      linkedinTokens.expires_at = Date.now() + refreshRes.data.expires_in * 1000;
      if (refreshRes.data.refresh_token) {
        linkedinTokens.refresh_token = refreshRes.data.refresh_token;
      }
      console.log("[LinkedIn] Token refreshed successfully.");
    } catch (refreshErr) {
      console.error("[LinkedIn] Token refresh failed:", refreshErr.response?.data || refreshErr.message);
      return res.status(401).json({ error: "Token expired and refresh failed. Re-authorize at /linkedin/auth." });
    }
  }

  const { text, author } = req.body;
  // author should be a LinkedIn URN like "urn:li:organization:XXXXX" or "urn:li:person:XXXXX"
  // If not provided, post as the authenticated user
  const authorUrn = author || `urn:li:person:${linkedinTokens.profile_sub}`;

  if (!text) {
    return res.status(400).json({ error: "Missing 'text' in request body." });
  }

  try {
    const postBody = {
      author: authorUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text },
          shareMediaCategory: "NONE",
        },
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
      },
    };

    const postRes = await axios.post("https://api.linkedin.com/v2/ugcPosts", postBody, {
      headers: {
        Authorization: `Bearer ${linkedinTokens.access_token}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
    });

    console.log(`[LinkedIn] Post published successfully. ID: ${postRes.data.id}`);
    res.json({ success: true, post_id: postRes.data.id });
  } catch (err) {
    console.error("[LinkedIn] Post error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// Get LinkedIn tokens (for Jarvis to retrieve)
app.get("/linkedin/tokens", (req, res) => {
  // Simple auth check — only allow from known sources
  const authHeader = req.headers["x-jarvis-key"];
  if (authHeader !== "jarvis-internal-2026") {
    return res.status(403).json({ error: "Unauthorized" });
  }
  res.json(linkedinTokens);
});

// Deduplicate events (Slack may retry)
const processedEvents = new Set();
const MAX_PROCESSED = 5000;

function markProcessed(eventId) {
  processedEvents.add(eventId);
  if (processedEvents.size > MAX_PROCESSED) {
    const first = processedEvents.values().next().value;
    processedEvents.delete(first);
  }
}

// Slack Events endpoint
app.post("/slack/events", async (req, res) => {
  const body = req.body;

  // 1. URL verification challenge
  if (body.type === "url_verification") {
    console.log("[Slack] URL verification challenge received.");
    return res.json({ challenge: body.challenge });
  }

  // 2. Acknowledge immediately (Slack wants a 200 within 3 s)
  res.status(200).send();

  // 3. Process event_callback
  if (body.type === "event_callback") {
    const event = body.event;
    const eventId = body.event_id || `${event.ts}-${event.channel}`;

    // Skip duplicates
    if (processedEvents.has(eventId)) return;
    markProcessed(eventId);

    // Only handle messages (not bot messages, not subtypes like joins)
    if (event.type !== "message" || event.subtype || event.bot_id) return;

    const text = event.text || "";
    const channel = event.channel;
    const user = event.user;

    console.log(`[Slack] Message from <${user}> in <${channel}>: ${text}`);

    const classification = classifyMessage(text);

    if (classification === "approved") {
      await postSlackMessage(channel, `✅ Got it — this is now *Approved*. I've updated the Google Doc.`);
      await updateDocStatus("Approved");
    } else if (classification === "hold") {
      await postSlackMessage(channel, `⏸️ Understood — placing this *On Hold*. I've updated the Google Doc.`);
      await updateDocStatus("On Hold");
    } else {
      await postSlackMessage(channel, `📝 Thanks <@${user}>, I've noted your feedback.`);
    }
  }
});

// ─── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🤖 Jarvis Slack Bot listening on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Slack events: http://localhost:${PORT}/slack/events`);
  console.log(`   LinkedIn auth: http://localhost:${PORT}/linkedin/auth`);
  console.log(`   LinkedIn status: http://localhost:${PORT}/linkedin/status`);
});

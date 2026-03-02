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

// LinkedIn OAuth config (Epipheo Page Manager app)
const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const LINKEDIN_REDIRECT_URI = process.env.LINKEDIN_REDIRECT_URI || "https://jarvis-slack-bot-production.up.railway.app/linkedin/callback";
const LINKEDIN_SCOPES = "w_organization_social r_organization_social";

// LinkedIn API version (YYYYMM format)
const LINKEDIN_API_VERSION = "202502";

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

// ─── LinkedIn helper: get valid access token (auto-refresh) ─────────────────
async function getLinkedInAccessToken() {
  if (!linkedinTokens.access_token) {
    throw new Error("Not authorized. Visit /linkedin/auth first.");
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
      throw new Error("Token expired and refresh failed. Re-authorize at /linkedin/auth.");
    }
  }

  return linkedinTokens.access_token;
}

// ─── LinkedIn helper: standard headers for REST API ─────────────────────────
function linkedinRestHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "LinkedIn-Version": LINKEDIN_API_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "50mb" }));

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
      linkedin_org_lookup: "GET /linkedin/org-lookup?vanityName=epipheo",
      linkedin_post_company: "POST /linkedin/post-company",
      linkedin_upload_image: "POST /linkedin/upload-image",
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

    // Try to get organization admin info to confirm access
    let orgInfo = "Organization access granted";
    try {
      const orgRes = await axios.get(
        "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&projection=(elements*(organization~(localizedName,vanityName)))",
        { headers: linkedinRestHeaders(access_token) }
      );
      const orgs = orgRes.data.elements || [];
      if (orgs.length > 0) {
        const orgNames = orgs.map(o => {
          const org = o["organization~"];
          return org ? `${org.localizedName} (${org.vanityName})` : "Unknown org";
        });
        orgInfo = `Admin of: ${orgNames.join(", ")}`;
        linkedinTokens.organizations = orgs;
      }
    } catch (orgErr) {
      console.warn("[LinkedIn] Could not fetch org info:", orgErr.response?.data || orgErr.message);
      orgInfo = "Could not verify organization access (this is OK — token is still valid)";
    }

    res.send(`
      <html>
      <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 80px auto; text-align: center;">
        <h1 style="color: #0A66C2;">✅ LinkedIn Connected!</h1>
        <p><strong>Epipheo Page Manager</strong> app authorized.</p>
        <p>${orgInfo}</p>
        <p>Access token expires: <strong>${new Date(linkedinTokens.expires_at).toLocaleString()}</strong></p>
        ${refresh_token ? '<p>Refresh token: ✅ Received (auto-renewal enabled)</p>' : '<p>Refresh token: ❌ Not provided (will need to re-authorize when token expires)</p>'}
        <hr>
        <p style="color: #666;">You can close this window. Jarvis can now post to the Epipheo LinkedIn company page.</p>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("[LinkedIn] Token exchange error:", err.response?.data || err.message);
    res.status(500).send(`<h1>Token Exchange Failed</h1><pre>${JSON.stringify(err.response?.data || err.message, null, 2)}</pre>`);
  }
});

// Status check
app.get("/linkedin/status", async (_req, res) => {
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
    expires_at: linkedinTokens.expires_at ? new Date(linkedinTokens.expires_at).toISOString() : null,
    has_refresh_token: !!linkedinTokens.refresh_token,
    scopes: LINKEDIN_SCOPES,
    api_version: LINKEDIN_API_VERSION,
  });
});

// ─── Organization Lookup ────────────────────────────────────────────────────
// GET /linkedin/org-lookup?vanityName=epipheo
app.get("/linkedin/org-lookup", async (req, res) => {
  try {
    const accessToken = await getLinkedInAccessToken();
    const { vanityName } = req.query;

    if (!vanityName) {
      return res.status(400).json({ error: "Missing 'vanityName' query parameter. Example: /linkedin/org-lookup?vanityName=epipheo" });
    }

    // Look up organization by vanity name
    const orgRes = await axios.get(
      `https://api.linkedin.com/rest/organizations?q=vanityName&vanityName=${encodeURIComponent(vanityName)}`,
      { headers: linkedinRestHeaders(accessToken) }
    );

    const elements = orgRes.data.elements || [];
    if (elements.length === 0) {
      return res.status(404).json({ error: `No organization found with vanityName "${vanityName}".` });
    }

    const org = elements[0];
    res.json({
      success: true,
      organization: {
        id: org.id,
        urn: `urn:li:organization:${org.id}`,
        name: org.localizedName,
        vanityName: org.vanityName,
        description: org.localizedDescription || null,
        logoUrl: org.logoV2 ? org.logoV2["original~"]?.elements?.[0]?.identifiers?.[0]?.identifier : null,
      },
    });
  } catch (err) {
    console.error("[LinkedIn] Org lookup error:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ─── List Administered Organizations ────────────────────────────────────────
// GET /linkedin/org-admin-list
app.get("/linkedin/org-admin-list", async (_req, res) => {
  try {
    const accessToken = await getLinkedInAccessToken();

    const orgRes = await axios.get(
      "https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR",
      { headers: linkedinRestHeaders(accessToken) }
    );

    const elements = orgRes.data.elements || [];
    const organizations = elements.map(e => ({
      organizationUrn: e.organization,
      role: e.role,
      state: e.state,
    }));

    res.json({ success: true, count: organizations.length, organizations });
  } catch (err) {
    console.error("[LinkedIn] Org admin list error:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ─── Post to LinkedIn Company Page (REST API) ──────────────────────────────
// POST /linkedin/post-company
// Body: { "orgId": "12345", "text": "Post text", "imageUrn": "(optional)", "videoUrn": "(optional)" }
app.post("/linkedin/post-company", async (req, res) => {
  try {
    const accessToken = await getLinkedInAccessToken();
    const { orgId, text, imageUrn, videoUrn } = req.body;

    if (!orgId) {
      return res.status(400).json({ error: "Missing 'orgId' in request body. Use /linkedin/org-lookup to find it." });
    }
    if (!text && !imageUrn && !videoUrn) {
      return res.status(400).json({ error: "Must provide at least 'text', 'imageUrn', or 'videoUrn'." });
    }

    const postBody = {
      author: `urn:li:organization:${orgId}`,
      commentary: text || "",
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };

    // Add image content if provided
    if (imageUrn) {
      postBody.content = {
        media: {
          title: "Image",
          id: imageUrn,
        },
      };
    }

    // Add video content if provided
    if (videoUrn) {
      postBody.content = {
        media: {
          title: "Video",
          id: videoUrn,
        },
      };
    }

    const postRes = await axios.post("https://api.linkedin.com/rest/posts", postBody, {
      headers: linkedinRestHeaders(accessToken),
    });

    // The REST API returns 201 with x-restli-id header for the post URN
    const postUrn = postRes.headers["x-restli-id"] || postRes.data?.id || "created";
    console.log(`[LinkedIn] Company page post published. URN: ${postUrn}`);
    res.json({ success: true, post_urn: postUrn });
  } catch (err) {
    console.error("[LinkedIn] Company post error:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ─── Upload Image to LinkedIn (for company page posts) ─────────────────────
// POST /linkedin/upload-image
// Body: { "orgId": "12345", "imageUrl": "https://example.com/image.jpg" }
app.post("/linkedin/upload-image", async (req, res) => {
  try {
    const accessToken = await getLinkedInAccessToken();
    const { orgId, imageUrl } = req.body;

    if (!orgId || !imageUrl) {
      return res.status(400).json({ error: "Missing 'orgId' or 'imageUrl' in request body." });
    }

    // Step 1: Initialize the image upload
    const initRes = await axios.post(
      "https://api.linkedin.com/rest/images?action=initializeUpload",
      {
        initializeUploadRequest: {
          owner: `urn:li:organization:${orgId}`,
        },
      },
      { headers: linkedinRestHeaders(accessToken) }
    );

    const { uploadUrl, image: imageUrn } = initRes.data.value;
    console.log(`[LinkedIn] Image upload initialized. URN: ${imageUrn}`);

    // Step 2: Download the image from the provided URL
    const imageResponse = await axios.get(imageUrl, { responseType: "arraybuffer" });
    const imageBuffer = Buffer.from(imageResponse.data);

    // Step 3: Upload the image binary to LinkedIn's upload URL
    await axios.put(uploadUrl, imageBuffer, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    console.log(`[LinkedIn] Image uploaded successfully. URN: ${imageUrn}`);
    res.json({ success: true, imageUrn });
  } catch (err) {
    console.error("[LinkedIn] Image upload error:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ─── Upload Video to LinkedIn (for company page posts) ─────────────────────
// POST /linkedin/upload-video
// Body: { "orgId": "12345", "videoUrl": "https://example.com/video.mp4", "fileSizeBytes": 12345678 }
app.post("/linkedin/upload-video", async (req, res) => {
  try {
    const accessToken = await getLinkedInAccessToken();
    const { orgId, videoUrl, fileSizeBytes } = req.body;

    if (!orgId || !videoUrl) {
      return res.status(400).json({ error: "Missing 'orgId' or 'videoUrl' in request body." });
    }

    // Step 1: Initialize the video upload
    const initRes = await axios.post(
      "https://api.linkedin.com/rest/videos?action=initializeUpload",
      {
        initializeUploadRequest: {
          owner: `urn:li:organization:${orgId}`,
          fileSizeBytes: fileSizeBytes || 0,
          uploadCaptions: false,
          uploadThumbnail: false,
        },
      },
      { headers: linkedinRestHeaders(accessToken) }
    );

    const { uploadInstructions, video: videoUrn } = initRes.data.value;
    console.log(`[LinkedIn] Video upload initialized. URN: ${videoUrn}`);

    // Step 2: Download the video from the provided URL
    const videoResponse = await axios.get(videoUrl, { responseType: "arraybuffer" });
    const videoBuffer = Buffer.from(videoResponse.data);

    // Step 3: Upload each chunk (usually single chunk for small videos)
    for (const instruction of uploadInstructions) {
      const start = instruction.firstByte || 0;
      const end = instruction.lastByte || videoBuffer.length;
      const chunk = videoBuffer.slice(start, end + 1);

      await axios.put(instruction.uploadUrl, chunk, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/octet-stream",
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
    }

    // Step 4: Finalize the upload
    await axios.post(
      "https://api.linkedin.com/rest/videos?action=finalizeUpload",
      {
        finalizeUploadRequest: {
          video: videoUrn,
          uploadToken: "",
          uploadedPartIds: [],
        },
      },
      { headers: linkedinRestHeaders(accessToken) }
    );

    console.log(`[LinkedIn] Video uploaded successfully. URN: ${videoUrn}`);
    res.json({ success: true, videoUrn });
  } catch (err) {
    console.error("[LinkedIn] Video upload error:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
  }
});

// ─── Legacy: Post to LinkedIn (personal profile via UGC API) ────────────────
// Kept for backward compatibility
app.post("/linkedin/post", async (req, res) => {
  try {
    const accessToken = await getLinkedInAccessToken();
    const { text, author } = req.body;
    const authorUrn = author || `urn:li:person:${linkedinTokens.profile_sub}`;

    if (!text) {
      return res.status(400).json({ error: "Missing 'text' in request body." });
    }

    // Use the new REST API for posting
    const postBody = {
      author: authorUrn,
      commentary: text,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };

    const postRes = await axios.post("https://api.linkedin.com/rest/posts", postBody, {
      headers: linkedinRestHeaders(accessToken),
    });

    const postUrn = postRes.headers["x-restli-id"] || postRes.data?.id || "created";
    console.log(`[LinkedIn] Post published successfully. URN: ${postUrn}`);
    res.json({ success: true, post_urn: postUrn });
  } catch (err) {
    console.error("[LinkedIn] Post error:", err.response?.data || err.message);
    res.status(err.response?.status || 500).json({ error: err.response?.data || err.message });
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
  console.log(`   Org lookup: http://localhost:${PORT}/linkedin/org-lookup?vanityName=epipheo`);
  console.log(`   Post to company: POST http://localhost:${PORT}/linkedin/post-company`);
  console.log(`   Upload image: POST http://localhost:${PORT}/linkedin/upload-image`);
  console.log(`   Upload video: POST http://localhost:${PORT}/linkedin/upload-video`);
});

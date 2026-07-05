import express from "express";
import session from "express-session";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

const {
  ANTHROPIC_API_KEY,
  MOODLE_BASE_URL,
  MOODLE_CLIENT_ID,
  MOODLE_CLIENT_SECRET,
  SESSION_SECRET,
  PORT = "3001",
  BASE_PATH = "/bodhiplanner",
} = process.env;

if (!ANTHROPIC_API_KEY) {
  console.error("FATAL: ANTHROPIC_API_KEY is not set in .env");
  process.exit(1);
}

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
    },
  },
}));

app.use(express.json({ limit: "100kb" }));

// Session for OAuth state
app.use(session({
  secret: SESSION_SECRET || "dev-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: "lax",
  },
}));

// Rate limiting on AI endpoints
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute per user
  message: { error: "Too many requests. Please wait a moment." },
  keyGenerator: (req) => req.session?.user?.id || req.ip,
});

// ─── Auth middleware ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ error: "Not authenticated. Please log in via Moodle." });
  }
  next();
}

// ─── OAuth 2 routes ────────────────────────────────────────────────────────────

// Step 1: Redirect user to Moodle's authorize endpoint
app.get(`${BASE_PATH}/auth/login`, (req, res) => {
  const redirectUri = `${MOODLE_BASE_URL}${BASE_PATH}/auth/callback`;
  const authorizeUrl = new URL(`${MOODLE_BASE_URL}/local/oauth/authorize.php`);
  
  // Moodle OAuth 2 provider uses /local/oauth or /admin/oauth2 depending on setup
  // Standard Moodle OAuth 2 uses: /login/oauth2/authorize
  const authUrl = `${MOODLE_BASE_URL}/admin/oauth2/authorize.php`;
  
  const params = new URLSearchParams({
    client_id: MOODLE_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "user_info",
    state: req.sessionID,
  });

  res.redirect(`${authUrl}?${params.toString()}`);
});

// Step 2: Moodle redirects back with an authorization code
app.get(`${BASE_PATH}/auth/callback`, async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    return res.redirect(`${BASE_PATH}/?error=oauth_denied`);
  }

  if (!code) {
    return res.redirect(`${BASE_PATH}/?error=no_code`);
  }

  // Verify state matches session
  if (state && state !== req.sessionID) {
    return res.redirect(`${BASE_PATH}/?error=state_mismatch`);
  }

  try {
    const redirectUri = `${MOODLE_BASE_URL}${BASE_PATH}/auth/callback`;

    // Exchange code for access token
    const tokenRes = await fetch(`${MOODLE_BASE_URL}/login/token.php`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: MOODLE_CLIENT_ID,
        client_secret: MOODLE_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      console.error("Token exchange failed:", tokenData);
      return res.redirect(`${BASE_PATH}/?error=token_failed`);
    }

    const accessToken = tokenData.access_token || tokenData.token;

    // Fetch user info from Moodle
    const userRes = await fetch(
      `${MOODLE_BASE_URL}/webservice/rest/server.php?` +
      new URLSearchParams({
        wstoken: accessToken,
        wsfunction: "core_webservice_get_site_info",
        moodlewsrestformat: "json",
      })
    );

    const userData = await userRes.json();

    if (userData.errorcode) {
      console.error("User info fetch failed:", userData);
      return res.redirect(`${BASE_PATH}/?error=user_fetch_failed`);
    }

    // Store user in session
    req.session.user = {
      id: userData.userid,
      name: userData.fullname || userData.username,
      username: userData.username,
      siteUrl: userData.siteurl,
    };

    req.session.save(() => {
      res.redirect(`${BASE_PATH}/`);
    });
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.redirect(`${BASE_PATH}/?error=server_error`);
  }
});

// Get current user session
app.get(`${BASE_PATH}/auth/me`, (req, res) => {
  if (req.session?.user) {
    res.json({ user: req.session.user });
  } else {
    res.json({ user: null });
  }
});

// Logout
app.post(`${BASE_PATH}/auth/logout`, (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// ─── AI Proxy routes (protected) ──────────────────────────────────────────────

app.post(`${BASE_PATH}/api/claude`, requireAuth, aiLimiter, async (req, res) => {
  const { system, userText, maxTokens = 1000 } = req.body;

  if (!system || !userText) {
    return res.status(400).json({ error: "Missing system or userText in request body." });
  }

  if (maxTokens > 2000) {
    return res.status(400).json({ error: "maxTokens cannot exceed 2000." });
  }

  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: Math.min(maxTokens, 2000),
        system,
        messages: [{ role: "user", content: userText }],
      }),
    });

    if (!claudeRes.ok) {
      const errBody = await claudeRes.text();
      console.error("Claude API error:", claudeRes.status, errBody);
      return res.status(502).json({ error: "AI service temporarily unavailable." });
    }

    const data = await claudeRes.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    res.json({ text });
  } catch (err) {
    console.error("Claude proxy error:", err);
    res.status(500).json({ error: "Internal server error." });
  }
});

// ─── Serve React frontend ─────────────────────────────────────────────────────

const clientDist = path.join(__dirname, "../client/dist");
app.use(BASE_PATH, express.static(clientDist));

// SPA fallback: serve index.html for any unmatched route under BASE_PATH
app.get(`${BASE_PATH}/*`, (req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

// Redirect bare /bodhiplanner to /bodhiplanner/
app.get(BASE_PATH, (req, res) => {
  res.redirect(`${BASE_PATH}/`);
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(parseInt(PORT), "0.0.0.0", () => {
  console.log(`✅ Bodhi Planner server running on port ${PORT}`);
  console.log(`   Base path: ${BASE_PATH}`);
  console.log(`   Moodle: ${MOODLE_BASE_URL}`);
});

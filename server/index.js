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
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  SESSION_SECRET,
  PORT = "3001",
  BASE_PATH = "/bodhiplanner",
  APP_URL = "https://moodle.braou.ac.in",
} = process.env;

if (!ANTHROPIC_API_KEY) {
  console.error("FATAL: ANTHROPIC_API_KEY is not set in .env");
  process.exit(1);
}
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error("FATAL: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env");
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

// ─── OAuth 2 routes (Google) ───────────────────────────────────────────────────

const REDIRECT_URI = `${APP_URL}${BASE_PATH}/auth/callback`;

// Step 1: Redirect to Google
app.get(`${BASE_PATH}/auth/login`, (req, res) => {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    state: req.sessionID,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

// Step 2: Google redirects back with code
app.get(`${BASE_PATH}/auth/callback`, async (req, res) => {
  const { code, error: oauthError } = req.query;

  if (oauthError || !code) {
    return res.redirect(`${BASE_PATH}/?error=oauth_denied`);
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });

    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      console.error("Google token error:", tokenData);
      return res.redirect(`${BASE_PATH}/?error=token_failed`);
    }

    // Get user info
    const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();

    // Store in session
    req.session.user = {
      id: userData.id,
      name: userData.name,
      email: userData.email,
      picture: userData.picture,
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

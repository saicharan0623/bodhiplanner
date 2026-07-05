# Bodhi Planner — Deployment Guide
## Hosted at: moodle.braou.ac.in/bodhiplanner

---

## Architecture

```
Browser → Apache2 (moodle.braou.ac.in)
            ↓ /bodhiplanner (ProxyPass)
         Docker container (port 3001)
            ├── Express server (OAuth + API proxy)
            └── React frontend (static files)
```

---

## Step 1: Configure Moodle OAuth 2 (one-time)

In Moodle Admin panel:

1. Go to **Site administration → Server → OAuth 2 services**
2. Click **Create new custom service**
3. Fill in:
   - Name: `Bodhi Planner`
   - Client ID: `bodhiplanner`
   - Client secret: (generate one, save it for .env)
   - Authorization endpoint: `https://moodle.braou.ac.in/admin/oauth2/authorize.php`
   - Token endpoint: `https://moodle.braou.ac.in/login/token.php`
   - Redirect URI: `https://moodle.braou.ac.in/bodhiplanner/auth/callback`
   - Scopes: `user_info`
4. Save and note the **Client ID** and **Client Secret**

> **Alternative approach**: If your Moodle doesn't have OAuth 2 provider
> configured, you can use Moodle's Web Services token auth instead.
> The server already supports token-based auth via `/login/token.php`.

---

## Step 2: Prepare the server

```bash
# SSH into the BRAOU server
ssh admin@moodle.braou.ac.in

# Install Docker if not already present
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Enable Apache proxy modules
sudo a2enmod proxy proxy_http headers
sudo systemctl restart apache2
```

---

## Step 3: Deploy the app

```bash
# Copy the bodhiplanner folder to the server
# (from your local machine)
scp -r bodhiplanner/ admin@moodle.braou.ac.in:/opt/

# On the server
cd /opt/bodhiplanner

# Create .env from template
cp .env.example .env
nano .env
# Fill in:
#   ANTHROPIC_API_KEY=sk-ant-your-real-key
#   MOODLE_CLIENT_ID=bodhiplanner
#   MOODLE_CLIENT_SECRET=your-secret-from-step-1
#   SESSION_SECRET=$(openssl rand -hex 32)

# Build and start
docker compose up -d --build

# Verify it's running
docker compose logs -f
# Should show: "✅ Bodhi Planner server running on port 3001"
```

---

## Step 4: Configure Apache2

```bash
# Edit your existing Moodle VirtualHost config
sudo nano /etc/apache2/sites-available/moodle.braou.ac.in.conf

# Add these lines INSIDE the <VirtualHost *:443> block:
ProxyPreserveHost On
ProxyPass /bodhiplanner http://127.0.0.1:3001/bodhiplanner
ProxyPassReverse /bodhiplanner http://127.0.0.1:3001/bodhiplanner

<Location /bodhiplanner>
    ProxyPassReverseCookiePath /bodhiplanner /bodhiplanner
    RequestHeader set X-Forwarded-Proto "https"
</Location>

# Test and reload
sudo apache2ctl configtest
sudo systemctl reload apache2
```

---

## Step 5: Verify

1. Visit: `https://moodle.braou.ac.in/bodhiplanner`
2. You should see the "Sign in with Moodle" button
3. Click it → redirects to Moodle login → returns authenticated
4. Generate a lesson plan to confirm Claude API works

---

## Maintenance Commands

```bash
# View logs
docker compose logs -f bodhiplanner

# Restart after code changes
docker compose up -d --build

# Stop
docker compose down

# Update just the .env (no rebuild needed)
docker compose restart
```

---

## Security Notes

- API key is ONLY on the server (never reaches browser)
- OAuth ensures only Moodle-authenticated teachers can access
- Rate limiting: 10 AI requests per minute per user
- Session expires after 24 hours
- Container runs as non-root user
- Helmet.js adds security headers (HSTS, CSP, etc.)

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| "502 Bad Gateway" | Docker container not running: `docker compose up -d` |
| OAuth redirect fails | Check redirect URI matches exactly in Moodle config |
| "Session expired" | Clear cookies, re-login |
| Claude API errors | Check ANTHROPIC_API_KEY in .env, verify billing |
| Apache won't start | `sudo apache2ctl configtest` to find syntax errors |

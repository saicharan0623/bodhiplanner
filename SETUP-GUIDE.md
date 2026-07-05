# Bodhi Planner — Complete Setup Guide (for BRAOU Staging Server)
# You need: SSH access to staging server + about 20 minutes

---

## What is Docker? (30-second version)

Docker is like a "box" that contains your app + everything it needs to run.
You don't install Node.js or anything else manually — Docker handles it all.
If something breaks, you just delete the box and rebuild. Zero mess on your server.

---

## PART 1: Install Docker on Staging Server

SSH into your staging server first:
```bash
ssh your-username@staging-server-ip
```

Then run these commands ONE BY ONE:

```bash
# 1. Update packages
sudo apt update

# 2. Install prerequisites
sudo apt install -y ca-certificates curl gnupg

# 3. Add Docker's official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# 4. Add Docker repository
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# 5. Install Docker
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# 6. Let your user run Docker without sudo
sudo usermod -aG docker $USER

# 7. Log out and back in for group change to take effect
exit
```

SSH back in, then verify:
```bash
docker --version
# Should show something like: Docker version 27.x.x
```

---

## PART 2: Upload the Project to Server

From your Windows machine (open Command Prompt or PowerShell):

```powershell
# Option A: Using scp (if you have OpenSSH)
scp -r C:\Users\HP\Desktop\moodeltemp\bodhi\bodhiplanner your-username@staging-server-ip:/opt/

# Option B: Using WinSCP or FileZilla
# Just drag the "bodhiplanner" folder to /opt/ on the server
```

If neither works, you can zip it:
```powershell
# On Windows
Compress-Archive -Path "C:\Users\HP\Desktop\moodeltemp\bodhi\bodhiplanner" -DestinationPath "C:\Users\HP\Desktop\bodhiplanner.zip"
```
Then upload the zip via FileZilla/WinSCP and unzip on server:
```bash
sudo apt install -y unzip
sudo unzip /path/to/bodhiplanner.zip -d /opt/
```

---

## PART 3: Configure the .env File

On the server:
```bash
cd /opt/bodhiplanner

# Create .env from the template
cp .env.example .env

# Edit it
nano .env
```

Fill in these values:
```
ANTHROPIC_API_KEY=sk-ant-your-actual-key-here
MOODLE_BASE_URL=https://moodle.braou.ac.in
MOODLE_CLIENT_ID=bodhiplanner
MOODLE_CLIENT_SECRET=paste-from-moodle-oauth-setup
SESSION_SECRET=paste-a-random-string-here
NODE_ENV=production
PORT=3001
BASE_PATH=/bodhiplanner
```

To generate a random session secret:
```bash
openssl rand -hex 32
```
Copy the output and paste it as SESSION_SECRET.

Save: `Ctrl+O`, Enter, `Ctrl+X`

---

## PART 4: Build and Start the App

```bash
cd /opt/bodhiplanner

# Build the Docker image (takes 1-2 minutes first time)
docker compose up -d --build
```

That's it! Check if it's running:
```bash
# See running containers
docker compose ps

# See logs (Ctrl+C to exit)
docker compose logs -f
```

You should see:
```
✅ Bodhi Planner server running on port 3001
```

---

## PART 5: Configure Apache2 (Reverse Proxy)

This tells Apache: "When someone visits /bodhiplanner, send the request to Docker."

```bash
# 1. Enable required Apache modules
sudo a2enmod proxy proxy_http headers
sudo systemctl restart apache2

# 2. Find your Moodle site config file
ls /etc/apache2/sites-enabled/
# Look for something like: moodle.braou.ac.in.conf or 000-default.conf or default-ssl.conf

# 3. Edit it
sudo nano /etc/apache2/sites-enabled/YOUR-CONFIG-FILE.conf
```

Add these lines INSIDE the `<VirtualHost>` block, BEFORE the closing `</VirtualHost>`:

```apache
    # ─── Bodhi Planner ─────────────────────────────
    ProxyPreserveHost On
    ProxyPass /bodhiplanner http://127.0.0.1:3001/bodhiplanner
    ProxyPassReverse /bodhiplanner http://127.0.0.1:3001/bodhiplanner

    <Location /bodhiplanner>
        RequestHeader set X-Forwarded-Proto "https"
    </Location>
```

Save and test:
```bash
# Check for syntax errors
sudo apache2ctl configtest
# Should say: Syntax OK

# Reload Apache
sudo systemctl reload apache2
```

---

## PART 6: Set Up Moodle OAuth (in Moodle Admin Panel)

1. Log into Moodle as admin
2. Go to: **Site administration → Server → Web services → External services**
3. Create a new service called `Bodhi Planner`
4. Enable it and add the function: `core_webservice_get_site_info`
5. Go to: **Site administration → Server → Web services → Manage tokens**
6. Create a token for the service

**Simpler alternative (recommended for staging):**
Since Moodle's built-in OAuth 2 provider setup can be complex, 
for the staging server we can use a simpler token-based approach.
Let me know and I can modify the server to use Moodle web service tokens directly.

---

## PART 7: Test It!

Visit: `https://your-staging-url/bodhiplanner`

You should see the Bodhi Planner login page.

---

## Common Commands You'll Need

```bash
# Start the app
cd /opt/bodhiplanner && docker compose up -d

# Stop the app
cd /opt/bodhiplanner && docker compose down

# Restart after changing .env
cd /opt/bodhiplanner && docker compose restart

# Rebuild after code changes
cd /opt/bodhiplanner && docker compose up -d --build

# View live logs
cd /opt/bodhiplanner && docker compose logs -f

# Check if container is running
docker ps
```

---

## If Something Goes Wrong

| Problem | Solution |
|---------|----------|
| `docker: command not found` | Docker not installed — redo Part 1 |
| `permission denied` on docker | Run `sudo usermod -aG docker $USER` then logout/login |
| Container won't start | Check logs: `docker compose logs` |
| "502 Bad Gateway" in browser | Container not running or Apache proxy not configured |
| Can't reach /bodhiplanner | Apache modules not enabled: `sudo a2enmod proxy proxy_http` |
| OAuth not working | Check MOODLE_BASE_URL in .env matches your actual Moodle URL |

---

## Disk Space Note

Docker images take ~200MB. Your server should have plenty of space.
Check with: `df -h`

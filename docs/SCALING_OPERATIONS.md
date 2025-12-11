# Scaling Operations Runbook

Complete guide for managing FlyLive Audio Server infrastructure on Digital Ocean.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Initial Setup](#initial-setup)
3. [Adding GitHub Secrets](#adding-github-secrets)
4. [Scaling Up](#scaling-up)
5. [Scaling Down](#scaling-down)
6. [Manual Deployments](#manual-deployments)
7. [Monitoring](#monitoring)
8. [Emergency Procedures](#emergency-procedures)
9. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### 1. Install doctl CLI

```bash
# macOS
brew install doctl

# Ubuntu/Debian
snap install doctl

# Windows (WSL)
sudo snap install doctl
```

### 2. Authenticate doctl

```bash
doctl auth init
# Paste your Digital Ocean API token when prompted
```

### 3. Add Your SSH Key

```bash
# Generate SSH key if you don't have one
ssh-keygen -t ed25519 -C "your-email@example.com"

# Add to Digital Ocean
doctl compute ssh-key create my-key --public-key "$(cat ~/.ssh/id_ed25519.pub)"

# Get fingerprint (you'll need this)
doctl compute ssh-key list
```

### 4. Configure `.env.deploy`

Copy the example file and set your values:

```bash
cp .env.deploy.example .env.deploy
```

Edit `.env.deploy` and set the **required** values:

```bash
# Required - your SSH key fingerprint
DO_SSH_KEY_FINGERPRINT=ab:cd:ef:12:34:...

# Required - shared secret with Laravel (must match MSAB_INTERNAL_KEY in Laravel Cloud)
LARAVEL_INTERNAL_KEY=your-32-character-key
```

All other values (GitHub repo, domains, regions) have sensible defaults. Uncomment and change if needed.

---

## Initial Setup

Run these once to create all infrastructure:

```bash
cd scripts/deploy
chmod +x *.sh

# 1. Create Infrastructure (VPC, DB, Droplet, Load Balancer)
./setup-infrastructure.sh

# 2. Setup SSL (HTTPS)
./setup-ssl.sh
```

**What this does:**

- Creates a private **VPC network** (secure communication).
- Launches a **Managed Valkey** cluster (Redis-compatible).
- Configures a **Firewall** (blocks unused ports).
- Launches the first **Audio Server Droplet**.
- Creates a **Load Balancer** with sticky sessions.
- Generates and attaches a **Let's Encrypt SSL Certificate**.

### Post-Setup Verification

1. **Configure DNS:**
   - In your DNS provider (if not using DO DNS), point `audio.flyliveapp.com` to the Load Balancer IP.
   - You can find the LB IP by running `./status.sh`.

2. **Test:**
   ```bash
   curl https://audio.flyliveapp.com/health
   # Should return: {"status":"ok",...}
   ```

---

## Adding GitHub Secrets

For automated CI/CD deployments:

1. Go to your GitHub repository
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Add these secrets:

| Secret Name                 | Value                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `DIGITALOCEAN_ACCESS_TOKEN` | Your DO API token (from [API Tokens page](https://cloud.digitalocean.com/account/api/tokens)) |
| `LARAVEL_INTERNAL_KEY`      | Same key as `MSAB_INTERNAL_KEY` in Laravel Cloud                                              |
| `VALKEY_PASSWORD`           | From DO Dashboard (Databases → Your Valkey → Connection Details)                              |

4. **Create Production Environment:**
   - Settings → Environments → New environment → Name: `production`
   - Optionally add required reviewers for production deploys

---

## Scaling Up

### When to Scale

| Concurrent Users | Recommended Servers | Droplet Size |
| ---------------- | ------------------- | ------------ |
| 0-5,000          | 1-2                 | c-4          |
| 5,000-15,000     | 2-3                 | c-8          |
| 15,000-40,000    | 3-5                 | c-8          |
| 40,000+          | 5+                  | c-8 or c-16  |

### Add More Servers

```bash
# Add 1 server (uses HEAD of master branch)
./scale-up.sh

# Add 3 servers (Parallel creation!)
./scale-up.sh 3

# Add 2 servers with specific code version
./scale-up.sh 2 a1b2c3d
```

The script will:

1. Generate unique names (`flylive-audio-02`, `03`...).
2. **Create droplets in parallel** (much faster).
3. Wait for them to boot and SSH to be ready.
4. Deploy the audio server code.
5. Add healthy droplets to the **Load Balancer**.

### Use Larger Servers

Edit `config.sh` before scaling:

```bash
export DO_DROPLET_SIZE="c-8"
./scale-up.sh 2
```

---

## Scaling Down

### Remove a Server

**Gracefully** remove a server without dropping active calls.

```bash
# See current servers
./status.sh

# Remove specific server
./scale-down.sh flylive-audio-03
```

The script will:

1. **Safety Check:** Verifies this isn't the last active server in the Load Balancer.
2. Remove from Load Balancer (stops new users).
3. Wait for connections to drain (Default: 60s).
4. Stop the container.
5. Ask for final confirmation.
6. Destroy the droplet.

### Emergency Scale Down (Skip Drain)

If a server is acting malicious or broken:

```bash
export DRAIN_TIMEOUT=0
./scale-down.sh flylive-audio-03
```

---

## Manual Deployments

### Deploy to All Servers (Rolling Update)

Updates servers one-by-one with zero downtime.

```bash
# Deploy latest HEAD
./update-all.sh

# [RECOMMENDED] This script automatically locks the Commit SHA
# of the remote branch before starting. This ensures ALL servers
# get the EXACT SAME code, even if someone pushes to master
# during the update.
```

### Deploy to Specific Server

```bash
# Deploy HEAD
./deploy-droplet.sh flylive-audio-01

# Deploy specific Commit SHA (Rollback or specific version)
./deploy-droplet.sh flylive-audio-01 a1b2c3d
```

---

## Monitoring

### Check Status

```bash
./status.sh
```

Shows:

- Droplet health (HTTP check).
- Load Balancer status & IP.
- Valkey cluster status.
- VPC and Firewall info.

### Health Endpoints

```bash
# Via load balancer
curl https://audio.flyliveapp.com/health

# Direct to droplet
curl http://DROPLET_IP:3030/health

# Detailed metrics
curl https://audio.flyliveapp.com/metrics
```

### Digital Ocean Monitoring

1. Enable Monitoring on droplets (Settings → Monitoring).
2. Create Alerts:
   - CPU > 80% for 5 minutes.
   - Memory > 90%.
   - Health check failures.

---

## Emergency Procedures

### Server Not Responding

```bash
# 1. Check health
curl http://DROPLET_IP:3030/health

# 2. Check container logs
ssh root@DROPLET_IP docker logs audio-server --tail 100

# 3. Restart container
ssh root@DROPLET_IP docker restart audio-server

# 4. If still failing, redeploy
./deploy-droplet.sh DROPLET_IP
```

### Rollback Deployment (Revert to old code)

If a bad update goes out:

1. Find the previous good Commit SHA (e.g., from GitHub history).
2. Redeploy that SHA to all servers:

```bash
# This feature is not built into update-all.sh directly yet,
# but you can use `deploy-droplet.sh` or edit update-all.sh or
# manually run:

./deploy-droplet.sh flylive-audio-01 <GOOD_COMMIT_SHA>
./deploy-droplet.sh flylive-audio-02 <GOOD_COMMIT_SHA>
# ...
```

### Complete Infrastructure Reset

> ⚠️ **Destroys everything!**

```bash
# Delete all droplets
doctl compute droplet delete --force $(doctl compute droplet list --tag-name flylive-audio --format ID --no-header | tr '\n' ' ')

# Delete load balancer
doctl compute load-balancer delete YOUR_LB_ID --force

# Delete Redis (data will be lost!)
doctl databases delete flylive-audio-valkey --force  # Check name first!

# Delete firewall and VPC
doctl compute firewall delete YOUR_FW_ID --force
doctl vpcs delete YOUR_VPC_ID

# Start fresh
./setup-infrastructure.sh
./setup-ssl.sh
```

---

## Troubleshooting

### "No audio" - ICE Failed

```bash
# Check MEDIASOUP_ANNOUNCED_IP matches droplet's public IP
ssh root@DROPLET_IP
grep MEDIASOUP_ANNOUNCED_IP /opt/audio-server/.env
curl ifconfig.me  # Should match
```

### WebSocket Connection Failed

1. Check `CORS_ORIGINS` includes your frontend domain.
2. Check firewall allows port 3030.
3. Check load balancer SSL certificate (`./setup-ssl.sh`).

### SSL Issues

If `https://audio.flyliveapp.com` fails:

1. Run `./setup-ssl.sh` again.
2. Ensure your DNS points to the Load Balancer IP.
3. Check DO Dashboard -> Load Balancers -> SSL.

### Valkey Connection Failed

```bash
# Test from droplet (requires valkey-cli or redis-cli installed)
ssh root@DROPLET_IP
# Or just check logs
docker logs audio-server | grep Redis
```

---

## Quick Reference

| Task              | Command                          | Notes                |
| ----------------- | -------------------------------- | -------------------- |
| **Check status**  | `./status.sh`                    |                      |
| **Setup SSL**     | `./setup-ssl.sh`                 | Run once after setup |
| **Add 1 server**  | `./scale-up.sh`                  | Uses HEAD            |
| **Add N servers** | `./scale-up.sh N`                | Parallel creation    |
| **Remove server** | `./scale-down.sh NAME`           | Drains connections   |
| **Update all**    | `./update-all.sh`                | **Pins commit SHA**  |
| **Update one**    | `./deploy-droplet.sh IP [SHA]`   | Supports SHA arg     |
| **Restart**       | `ssh root@IP docker restart ...` |                      |

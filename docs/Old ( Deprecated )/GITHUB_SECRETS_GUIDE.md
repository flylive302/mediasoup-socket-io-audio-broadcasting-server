# GitHub Secrets Configuration Guide

This guide explains which variables from your `.env.deploy` file need to be added to GitHub Secrets, and how to obtain any missing values.

## Required GitHub Secrets for Production Environment

Your workflow uses the `production` environment, so secrets must be configured at:
**Settings → Environments → production → Secrets**

### 1. `DIGITALOCEAN_ACCESS_TOKEN` ⚠️ **MISSING FROM .env.deploy**

**What it is:** Your DigitalOcean API token for programmatic access.

**How to get it:**
1. Go to [DigitalOcean API Tokens](https://cloud.digitalocean.com/account/api/tokens)
2. Click **Generate New Token**
3. Give it a name (e.g., "GitHub Actions Deploy")
4. Select **Write** scope (or **Read and Write**)
5. Click **Generate Token**
6. **Copy the token immediately** (you won't see it again)

**Add to GitHub:**
- Go to your repo → Settings → Environments → production → Secrets
- Click **Add secret**
- Name: `DIGITALOCEAN_ACCESS_TOKEN`
- Value: Paste the token you just copied

---

### 2. `SSH_PRIVATE_KEY` ⚠️ **DIFFERENT FROM .env.deploy**

**What it is:** The **contents** of your SSH private key file (not the file path).

**Difference from .env.deploy:**
- `.env.deploy` has: `DO_SSH_PRIVATE_KEY=~/.ssh/id_ed25519` (file path)
- GitHub needs: The actual key content (the file contents)

**How to get it:**
```bash
# If you already have the key file path in .env.deploy:
cat ~/.ssh/id_ed25519

# Or if your path is different:
cat /path/to/your/private/key
```

**Important:** 
- Copy the **entire output** including:
  - `-----BEGIN OPENSSH PRIVATE KEY-----` (or `-----BEGIN RSA PRIVATE KEY-----`)
  - All the key content
  - `-----END OPENSSH PRIVATE KEY-----` (or `-----END RSA PRIVATE KEY-----`)

**Add to GitHub:**
- Name: `SSH_PRIVATE_KEY`
- Value: Paste the entire private key content

**Security Note:** This must be the same key that corresponds to `DO_SSH_KEY_FINGERPRINT` in your `.env.deploy`.

---

### 3. `LARAVEL_INTERNAL_KEY` ✅ **ALREADY IN .env.deploy**

**What it is:** Shared secret key between your Laravel backend and audio server.

**From your .env.deploy:**
- Copy the value of `LARAVEL_INTERNAL_KEY`

**Add to GitHub:**
- Name: `LARAVEL_INTERNAL_KEY`
- Value: Same value as in your `.env.deploy`

**Note:** This must match `MSAB_INTERNAL_KEY` in your Laravel Cloud configuration.

---

### 4. `VALKEY_PASSWORD` ⚠️ **MISSING FROM .env.deploy**

**What it is:** Password for your DigitalOcean Managed Valkey (Redis-compatible) database.

**How to get it:**
1. Go to [DigitalOcean Dashboard](https://cloud.digitalocean.com/databases)
2. Click on your Valkey database (should be named `flylive-audio-valkey` or similar)
3. Click **Connection Details** tab
4. Look for the **Password** field
5. If you don't see it or it's hidden:
   - Click **Reset Password** to generate a new one
   - **Save it immediately** (you won't see it again)

**Alternative (using doctl CLI):**
```bash
# If you have doctl configured locally:
doctl databases connection flylive-audio-valkey --format Password --no-header
```

**Add to GitHub:**
- Name: `VALKEY_PASSWORD`
- Value: The password from DigitalOcean

---

## Summary Table

| GitHub Secret Name | Source | Status |
|-------------------|--------|--------|
| `DIGITALOCEAN_ACCESS_TOKEN` | Create new token in DO Dashboard | ⚠️ **Need to create** |
| `SSH_PRIVATE_KEY` | Contents of `DO_SSH_PRIVATE_KEY` file from `.env.deploy` | ⚠️ **Need to extract** |
| `LARAVEL_INTERNAL_KEY` | Copy from `.env.deploy` | ✅ **Already have** |
| `VALKEY_PASSWORD` | Get from DO Dashboard → Databases | ⚠️ **Need to retrieve** |

---

## Variables NOT Needed in GitHub Secrets

These variables from `.env.deploy` are **NOT** needed as GitHub secrets because they are:
- Used only by local deployment scripts
- Hardcoded in the workflow
- Retrieved dynamically during deployment

**Do NOT add these to GitHub:**
- `DO_SSH_KEY_FINGERPRINT` - Used by local scripts only
- `DO_SSH_PRIVATE_KEY` - Path, not needed (we use the key content instead)
- `GITHUB_REPO` - Hardcoded in workflow
- `GITHUB_BRANCH` - Hardcoded in workflow (master)
- `LARAVEL_API_URL` - Hardcoded in workflow
- `AUDIO_DOMAIN` - Not used in workflow
- `CORS_ORIGINS` - Hardcoded in workflow
- `DO_REGION` - Hardcoded in workflow (sgp1)
- `PROJECT_NAME` - Hardcoded in workflow (flylive-audio)
- All other configuration variables

---

## Step-by-Step Setup

1. **Create DigitalOcean API Token:**
   - [DigitalOcean API Tokens](https://cloud.digitalocean.com/account/api/tokens)
   - Generate new token with Write access
   - Copy token → Add to GitHub as `DIGITALOCEAN_ACCESS_TOKEN`

2. **Extract SSH Private Key:**
   - From your `.env.deploy`, note the `DO_SSH_PRIVATE_KEY` path
   - Run: `cat ~/.ssh/id_ed25519` (or your path)
   - Copy entire output → Add to GitHub as `SSH_PRIVATE_KEY`

3. **Copy Laravel Internal Key:**
   - From `.env.deploy`, copy `LARAVEL_INTERNAL_KEY` value
   - Add to GitHub as `LARAVEL_INTERNAL_KEY`

4. **Get Valkey Password:**
   - [DigitalOcean Databases](https://cloud.digitalocean.com/databases)
   - Open your Valkey database → Connection Details
   - Copy password → Add to GitHub as `VALKEY_PASSWORD`

5. **Verify Setup:**
   - Go to: Settings → Environments → production → Secrets
   - You should see all 4 secrets listed
   - Try running the workflow again

---

## Troubleshooting

### "Input required and not supplied: token"
- Make sure `DIGITALOCEAN_ACCESS_TOKEN` is added to the **production environment**, not just repository secrets

### "Permission denied (publickey)" during SSH
- Verify `SSH_PRIVATE_KEY` contains the full key (including BEGIN/END lines)
- Ensure it matches the public key in DigitalOcean
- Check that the key corresponds to `DO_SSH_KEY_FINGERPRINT` in `.env.deploy`

### "Failed to retrieve Valkey connection info"
- Verify `VALKEY_PASSWORD` is correct
- Check that the Valkey database exists and is accessible
- Ensure `DIGITALOCEAN_ACCESS_TOKEN` has database read permissions

### Secret not found errors
- Remember: Secrets must be in **Settings → Environments → production**, not just repository secrets
- The workflow uses `environment: production`, so it only looks at environment-level secrets


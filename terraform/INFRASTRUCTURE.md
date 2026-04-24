# FlyLive Audio Server — Infrastructure Reference

> **Scope:** MSAB (MediaSoup Audio Broadcasting Server) Terraform stack.  
> **Regions:** Mumbai (`ap-south-1`) + Frankfurt (`eu-central-1`)  
> **Terraform:** >= 1.10 required (see § State Backend)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Component Deep-Dive](#2-component-deep-dive)
3. [Critical Review](#3-critical-review)
4. [Deployment Guide (New AWS Account)](#4-deployment-guide-new-aws-account)
5. [Cloudflare Setup](#5-cloudflare-setup)
6. [GitHub CI/CD Setup](#6-github-cicd-setup)

---

## 1. Architecture Overview

### 1.1 What This Is

FlyLive runs live audio rooms using **WebRTC**. The MSAB server is the SFU (Selective Forwarding Unit) — it receives audio from speakers and fans it out to listeners without mixing, keeping CPU usage low. This Terraform stack provisions the cloud infrastructure that runs MSAB.

### 1.2 Global Topology

```
Internet
   │
   ├── TCP 443 (WebSocket/signaling) ──────► AWS Global Accelerator
   │                                              │   2 static anycast IPs
   │                                    ┌─────────┴──────────┐
   │                                    ▼                    ▼
   │                             NLB Mumbai           NLB Frankfurt
   │                          (ap-south-1)           (eu-central-1)
   │                          ┌──────────┐           ┌──────────┐
   │                          │  EC2 ×2  │           │  EC2 ×2  │
   │                          │  (ASG)   │           │  (ASG)   │
   │                          └──────────┘           └──────────┘
   │                          ElastiCache             ElastiCache
   │                          Redis (HA)              Redis (HA)
   │
   └── UDP 10000–59999 (WebRTC media) ──► EC2 public IP DIRECTLY
       (bypasses Global Accelerator — GA is TCP-only)
```

**Key insight:** GA routes the WebSocket handshake to the nearest region. Once the client knows the EC2 instance's public IP from the signaling exchange, WebRTC media UDP flows directly to that IP — bypassing GA entirely.

### 1.3 Request Flow

```
User opens audio room
        │
        ▼
DNS: audio.flyliveapp.com → Global Accelerator anycast IP
        │
        ▼
Global Accelerator routes TCP:443 → nearest NLB
        │ (source_ip sticky: same IP always hits same instance)
        ▼
NLB (TLS termination) → EC2 instance (port 3030, HTTP)
        │
        ▼
MSAB (Node.js + Mediasoup) ── WebSocket handshake ──► client
        │                    ── WebRTC SDP/ICE offer ──► client
        │
        ▼
WebRTC media UDP: client ◄──────────────────────────► EC2 public IP
                         (direct, bypasses NLB + GA)
```

### 1.4 Event Flow (Laravel → MSAB)

```
Laravel backend
        │
        │  SNS Publish (IAM authenticated)
        ▼
SNS Topic: flylive-audio-msab-events   (Mumbai, global)
        │
        ├── HTTPS POST → NLB Mumbai /api/events?key=<internal_key>
        │
        └── HTTPS POST → NLB Frankfurt /api/events?key=<internal_key>
             (both regions receive EVERY event — fan-out, not geo-routing)
```

### 1.5 Module Map

```
terraform/
├── main.tf                    ← Root: wires all modules together
├── variables.tf               ← All input variables + defaults
├── outputs.tf                 ← DNS names, ARNs, etc.
└── modules/
    ├── networking/            ← VPC, subnets, security groups (per region)
    ├── redis/                 ← ElastiCache Replication Group (per region)
    ├── ssl/                   ← ACM certificate (per region)
    ├── loadbalancer/          ← NLB + listeners + target group (per region)
    ├── autoscaling/           ← Launch Template + ASG + lifecycle (per region)
    │   └── user-data.sh       ← EC2 bootstrap script
    ├── cloudwatch/            ← Alarms + dashboard (per region)
    ├── global-accelerator/    ← Anycast routing (global)
    ├── ecr/                   ← Container registry (global, Mumbai)
    ├── iam/                   ← EC2 role + instance profile (global)
    ├── ssm/                   ← Secrets in Parameter Store (per region)
    ├── sns/                   ← Event bus (global, Mumbai)
    └── compute/               ← ⚠️ ORPHANED — not referenced in main.tf
```

---

## 2. Component Deep-Dive

### 2.1 State Backend

| Property | Value |
|----------|-------|
| Service | S3 + native S3 lock |
| Bucket | `flylive-audio-tfstate-<ACCOUNT_ID>` |
| Key | `phase1/terraform.tfstate` |
| Region | `ap-south-1` |
| Encryption | SSE-S3 |
| Locking | `use_lockfile = true` (Terraform 1.10+ native, no DynamoDB needed) |

> **⚠️ New account:** The bucket name is hardcoded with the old account ID. You MUST create a new bucket and update `main.tf` before `terraform init`. See § 4.

### 2.2 Networking

Two identical VPCs, one per region.

```
VPC: 10.10.0.0/16
 ├── Public Subnet AZ-a:  10.10.1.0/24   ← EC2 instances (auto-public-IP)
 ├── Public Subnet AZ-b:  10.10.2.0/24   ← EC2 instances (auto-public-IP)
 ├── Private Subnet AZ-a: 10.10.10.0/24  ← Redis only
 └── Private Subnet AZ-b: 10.10.11.0/24  ← Redis only

Internet Gateway → Public Route Table (0.0.0.0/0 → IGW)
(No NAT Gateway — Redis doesn't need internet access)
```

**Security Groups:**

| SG | Port(s) | Protocol | Source | Purpose |
|----|---------|----------|--------|---------|
| MSAB | 3030 | TCP | 0.0.0.0/0 | App / WebSocket / health check |
| MSAB | 10000–59999 | UDP | 0.0.0.0/0 | WebRTC media |
| MSAB | 10000–59999 | TCP | 0.0.0.0/0 | WebRTC TCP fallback |
| MSAB | 40000–49999 | UDP | 10.10.0.0/16 | SFU cascade (⚠️ see § 3.3) |
| MSAB | 0–65535 | all | — | Egress (all out) |
| Redis | 6379 | TCP | MSAB SG | Redis from MSAB only |

> **No SSH port 22.** Shell access via AWS Systems Manager Session Manager (browser console or `aws ssm start-session`).

### 2.3 Redis (ElastiCache)

| Property | Value |
|----------|-------|
| Engine | Redis 7.1 |
| Node type | `cache.r7g.large` (13.07 GB RAM, Graviton3) |
| Topology | 1 primary + 1 replica across 2 AZs |
| Failover | Automatic Multi-AZ |
| Auth | AUTH token (16–128 chars) |
| Encryption | TLS in-transit + AES at-rest |
| Eviction | `allkeys-lru` |
| Placement | Private subnets |

Each region has its own independent Redis cluster. Redis is for intra-region state only (rooms, sessions). Cross-region coordination uses SFU cascade (plainTransport RTP pipes).

### 2.4 SSL / ACM

One certificate per region, covering:
- `audio.flyliveapp.com`
- `*.audio.flyliveapp.com`

Validation method: **DNS** (not email). The certificate will NOT issue until DNS CNAME records are created in Cloudflare. Terraform will block for up to 10 minutes waiting for validation. See § 5.1 for exact records.

### 2.5 Network Load Balancer

| Property | Value |
|----------|-------|
| Type | Network (layer 4 — no WAF support) |
| Scheme | Internet-facing |
| Subnets | Both public subnets (cross-zone enabled) |
| Listener 1 | TCP:3030 → target group (direct, no TLS) |
| Listener 2 | TLS:443 → target group (terminates TLS with ACM cert) |
| Health check | HTTP GET /health, port 3030, 30s interval |
| Healthy threshold | 2 consecutive passes |
| Unhealthy threshold | 3 consecutive failures |
| Stickiness | source_ip (same client IP → same instance) |

Source-IP stickiness is critical for WebSocket connections. A socket.io client connecting with the same IP must land on the same instance (same room state). Without stickiness, reconnects would hit a different instance with no session state.

### 2.6 Auto Scaling Group

| Property | Value |
|----------|-------|
| Instance type | `c7i.xlarge` (4 vCPU, 8 GB RAM, Intel Ice Lake) |
| AMI | Latest Ubuntu 24.04 LTS (Canonical) |
| Min instances | 2 |
| Desired | 2 |
| Max instances | 15 |
| Scaling trigger | CPU target tracking at 60% |
| Root volume | 30 GB gp3 encrypted |
| IMDSv2 | Required (hop limit = 2 for Docker host network) |
| Monitoring | Detailed (1-minute CloudWatch) |

**Lifecycle hooks:**
- **Launch hook (5 min):** ASG holds instance in `Pending:Wait` while user-data runs. The bootstrap script explicitly calls `complete-lifecycle-action` after health check passes, so the instance only becomes `InService` when the app is confirmed healthy.
- **Terminate hook (15 min):** ASG holds in `Terminating:Wait`. The `msab-lifecycle.service` (systemd) polls for this state and calls `POST /admin/drain` to migrate rooms before allowing termination.

**Rolling deployments:** `instance_refresh` with 50% min healthy, 300s warmup. Deploying a new image requires updating the Launch Template (image tag) and triggering a refresh.

**Capacity math (current config):**
- 3 MediaSoup workers per instance (vCPU − 1)
- Max 100 rooms per worker → 300 rooms per instance
- Max 15 instances per region × 2 regions = 9,000 rooms system-wide
- Max 700 listeners per distribution router
- **Real-world concurrent user capacity ≈ 5,000–9,000 active rooms** depending on listener density

### 2.7 EC2 Bootstrap (user-data.sh)

On first boot each instance:

1. `apt-get update && upgrade` + install Docker + AWS CLI v2
2. Kernel tuning: BBR congestion control, 26 MB UDP buffers, 1M file descriptors
3. `iptables NOTRACK` on WebRTC UDP range (removes connection tracking overhead — large throughput win for UDP)
4. Get public IP from IMDSv2
5. ECR login and `docker pull` (all regions authenticate cross-region to `ap-south-1` ECR)
6. Fetch secrets from SSM Parameter Store (JWT, internal key, session secret, TURN key, Redis AUTH)
7. Validate that JWT, internal key, and Redis AUTH are non-empty — **abort if any are missing**
8. Write non-sensitive config to `.env` file
9. `docker run` with `--network host` (required for mediasoup to announce the correct public IP)
10. Poll `/health` for up to 120 seconds
11. Call `complete-lifecycle-action` to signal ASG the instance is ready
12. Install and start `msab-lifecycle.service` (systemd drain monitor)

**Memory allocation:** `--memory=7g --memory-swap=7g` on 8 GB instance. Leaves 1 GB for OS/Docker daemon.

### 2.8 ECR (Container Registry)

Single ECR repository in `ap-south-1`:
```
<account_id>.dkr.ecr.ap-south-1.amazonaws.com/flylive-audio/msab:<tag>
```

Lifecycle policy:
- Untagged images: expire after 1 day
- Tagged images (prefix `sha-`): keep last 10

Image scanning on push is enabled (basic scanning for known CVEs).

Frankfurt instances pull cross-region from Mumbai ECR. This adds 10–30 seconds of extra pull time per cold start due to cross-region transfer latency.

### 2.9 IAM

The EC2 instance role (`flylive-audio-ec2-role`) has these inline policies:

| Policy | Permissions |
|--------|-------------|
| cloudwatch-metrics | `cloudwatch:PutMetricData` (restricted to `FlyLive/MSAB` namespace) |
| asg-lifecycle | `CompleteLifecycleAction`, `DescribeAutoScalingInstances`, `RecordLifecycleActionHeartbeat` |
| ec2-describe | `DescribeInstances`, `DescribeTags` |
| cloudwatch-logs | Logs write to `/flylive-audio/*` log groups |
| ecr-pull | `GetAuthorizationToken`, `BatchGetImage`, `GetDownloadUrlForLayer`, `BatchCheckLayerAvailability` |
| ssm-parameters | `GetParameter`, `GetParameters` on `arn:aws:ssm:*:*:parameter/flylive-audio/*` |

Managed policy attachment: `AmazonSSMManagedInstanceCore` (enables SSM Session Manager shell access).

### 2.10 SSM Parameter Store (Secrets)

All secrets stored as `SecureString` (KMS encrypted) in both regions:

| Parameter path | Content |
|---------------|---------|
| `/flylive-audio/jwt-secret` | JWT signing secret (shared with Laravel) |
| `/flylive-audio/laravel-internal-key` | Service-to-service auth key |
| `/flylive-audio/session-secret` | Express session signing key |
| `/flylive-audio/cloudflare-turn-api-key` | TURN credential generation API key |
| `/flylive-audio/redis-auth-token` | Redis AUTH password |

Secrets are fetched at boot, passed to Docker via `-e` flags, and never written to the `.env` file on disk. The `redis_password` variable in the Terraform autoscaling module exists for historical reasons but is not rendered into the user-data script — secrets come from SSM only.

### 2.11 SNS (Event Bus)

```
Topic: arn:aws:sns:ap-south-1:<account>:flylive-audio-msab-events

Subscriptions (HTTPS):
  → https://<nlb-mumbai-dns>/api/events?key=<internal_key>
  → https://<nlb-frankfurt-dns>/api/events?key=<internal_key>

Raw message delivery: enabled (no SNS JSON envelope wrapper)
```

Laravel authenticates to SNS via IAM. SNS authenticates to MSAB via the `?key=` query parameter (the `laravel_internal_key` value). Both regional endpoints receive every event — SNS does not geo-route here. This is intentional: room events must reach all regions.

### 2.12 Global Accelerator

```
Static IPs: 2 anycast IPs (point audio.flyliveapp.com CNAME/A here)
Listener: TCP:443
Endpoint groups:
  ap-south-1  → Mumbai NLB (weight 100)
  eu-central-1 → Frankfurt NLB (weight 100)

Health check: TCP:443, every 30s, threshold 3
client_ip_preservation: false (NLB + GA incompatibility)
```

GA performs latency-based routing: a user in Asia hits Mumbai, a user in Europe hits Frankfurt. If one endpoint group's health check fails 3 times, GA routes all traffic to the surviving region automatically.

### 2.13 CloudWatch

**Alarms (operational, per region):**

| Alarm | Metric | Threshold | Action |
|-------|--------|-----------|--------|
| high-connections-alert | `FlyLive/MSAB ActiveConnections` | > variable (default 1000) | SNS alert |
| no-workers-alert | `FlyLive/MSAB WorkerCount` | < 1 for 2 min | SNS alert |
| high-cpu-alert | `FlyLive/MSAB WorkerCPU` | > variable (default 80%) | SNS alert |
| zero-healthy-hosts | `AWS/NetworkELB HealthyHostCount` | < 1 | SNS alert |

**Alarms (ASG-embedded, per region):**

| Alarm | Metric | Action |
|-------|--------|--------|
| high-connections | `FlyLive/MSAB ActiveConnections > 500` | Visibility only (no scaling action) |
| low-connections | `FlyLive/MSAB ActiveConnections < 100` | Visibility only |

Scaling is handled by CPU target tracking (60%) — the connection alarms are for dashboards only.

**Dashboard** (`flylive-audio-operations`): Active connections, active rooms, worker count, CPU %, per-instance breakdowns, NLB flow metrics, ASG instance count, alarm status panel.

---

## 3. Critical Review

### 3.1 🔴 BLOCKER — S3 Backend Hardcoded to Old Account ID

**File:** `main.tf:19`  
**Issue:** `bucket = "flylive-audio-tfstate-778477255323"` embeds the old AWS account ID. A new account cannot access this bucket, and `terraform init` will fail immediately.

**Fix (Phase 4 step 0):**
1. Create a new S3 bucket in the new account (see § 4.4)
2. Change the bucket name in `main.tf` OR use `-backend-config` override at init time

---

### 3.2 🔴 BLOCKER — ACM Certificate Will Hang `terraform apply`

**File:** `modules/ssl/main.tf`  
**Issue:** `aws_acm_certificate_validation` blocks until DNS validation succeeds. DNS is on Cloudflare, not Route53. Terraform has no way to auto-create the CNAME records. If the operator doesn't create the records in Cloudflare before/during `apply`, the resource times out after 10 minutes and the entire apply fails.

**Impact:** NLB TLS listener creation depends on the validated certificate ARN. Without it, no HTTPS, no GA routing.

**Fix:** Before or immediately during `terraform apply`, add ACM validation CNAMEs to Cloudflare. Steps in § 5.1.

---

### 3.3 🟠 SECURITY — SFU Cascade Security Group Fix Is Ineffective

**File:** `modules/networking/main.tf:123–130`  
**Comment:** "AUDIT-010 FIX: restricted to VPC CIDRs only (was 0.0.0.0/0)"

**Issue:** AWS Security Group rules use OR logic. The SFU cascade rule (ports 40000–49999 UDP, source `10.10.0.0/16`) is a subset of the WebRTC rule (ports 10000–59999 UDP, source `0.0.0.0/0`). The broader rule already permits any source on those ports. The cascade rule adds nothing — ports 40000–49999 remain open to the entire internet.

**Also note:** SFU cascade is cross-region (Mumbai ↔ Frankfurt). The instances' public IPs do NOT originate from `10.10.0.0/16` — they come from the internet. Even if the fix worked, it would block the cascade.

**Fix options:**
- Accept internet exposure on those ports (they're already in the WebRTC range — not a new attack surface)
- OR: Move cascade to a dedicated port range OUTSIDE the WebRTC range, restrict that range to the other VPC's CIDR via VPC Peering, and configure mediasoup `plainTransport` to use that range

---

### 3.4 🟠 SECURITY — SNS Authentication via URL Query Parameter

**File:** `modules/sns/main.tf:21–28`  
**Issue:** `laravel_internal_key` is appended as `?key=<value>` in the SNS HTTPS subscription URL. This value appears in:
- SNS delivery logs (CloudWatch Logs)
- CloudTrail API call records
- MSAB access logs

**Fix (proper):** MSAB should validate the SNS message signature (SNS signs every delivery with its public key). The MSAB `/api/events` handler should verify `x-amz-sns-message-signature` against SNS's published certificate. This eliminates the need for a shared secret in the URL.

**Short-term mitigation:** Rotate the `laravel_internal_key` regularly and audit CloudTrail for unexpected SNS publishes.

---

### 3.5 🟡 RELIABILITY — CloudWatch Logs Not Actually Shipped

**File:** `modules/iam/main.tf:97–117`, `modules/autoscaling/user-data.sh:202`  
**Issue:** IAM grants `logs:PutLogEvents` but the container runs with `--log-driver=json-file`. Logs rotate on disk (`max-size=100m, max-file=5`) and are permanently lost when the instance terminates. The IAM policy is vestigial.

**Impact:** Zero log retention across ASG instance refreshes or scale-in events. Debugging production incidents requires ssh/SSM access to a live instance.

**Fix:** Either:
- Switch Docker log driver to `awslogs` (the comment says this was attempted but failed on Docker 29.x)
- Install the CloudWatch Agent alongside Docker and configure log streaming from the Docker JSON log files

---

### 3.6 🟡 RELIABILITY — Bootstrap May Exceed 5-Minute Launch Hook

**File:** `modules/autoscaling/user-data.sh`  
**Issue:** The launch lifecycle hook allows 5 minutes (300s). Cold boot sequence:
- `apt-get upgrade` ≈ 60–120s
- Docker install ≈ 30–60s
- AWS CLI install ≈ 30s
- ECR cross-region pull (Frankfurt ← Mumbai) ≈ 30–120s (image size dependent)
- App startup + 120s health poll ≈ 120s

**Total worst case ≈ 430s** — exceeds the 300s hook timeout. The script calls `complete-lifecycle-action` explicitly before the timeout, but if the health check loop runs the full 120 seconds, the hook will likely expire first. In that case, `default_result = "CONTINUE"` still proceeds, but the instance may enter `InService` before the app is fully ready, causing initial health check failures.

**Fix:** Pre-bake a custom AMI with Docker + AWS CLI already installed. This reduces cold boot to ~60s and makes the 300s hook comfortable.

---

### 3.7 🟡 MISSING VALIDATION — Empty Session Secret Not Caught

**File:** `variables.tf:82–84`, `modules/autoscaling/user-data.sh:113–127`  
**Issue:** `session_secret` has `default = ""`. The bootstrap validation checks JWT, LARAVEL_INTERNAL_KEY, and REDIS_AUTH — but NOT session_secret. If the operator omits this variable, the app starts with an empty session signing key, making all sessions trivially forgeable.

**Fix:** Add `session_secret` to the validation loop in user-data.sh.

---

### 3.8 🟡 STALE CODE — `compute` Module Is Orphaned

**File:** `modules/compute/` (directory exists)  
**Issue:** This module was the original single-EC2 deployment. It is not referenced anywhere in `main.tf`. Comments say it ran "alongside" the ASG during cutover, but the cutover is complete. The directory is dead code.

**Risk:** Future readers may confuse it for active infrastructure.

**Fix:** Delete `modules/compute/`.

---

### 3.9 🟢 GOOD — IMDSv2 Hop Limit Is Correct for Docker Host Networking

`http_put_response_hop_limit = 2` is required when Docker containers need to access the EC2 metadata service. `--network host` means the container shares the host's IP stack, so hop_limit = 1 would work — but limit = 2 is a safe default that also works with bridge networking if changed later.

### 3.10 🟢 GOOD — Lifecycle Drain Is Well-Implemented

The drain service polls for `Terminating:Wait`, calls the MSAB drain endpoint, waits up to 15 minutes for rooms to migrate, then completes the hook. The `default_result = "CONTINUE"` ensures instances eventually terminate even if the drain API fails. This is the correct approach for stateful WebSocket servers.

### 3.11 Scale Assessment for 1M Monthly Users

1M MAU is a marketing metric. What matters is **peak concurrent users**.

A typical social audio app has:
- DAU/MAU ≈ 10–20% → 100,000–200,000 daily active users
- Peak concurrent ≈ 2–5% of DAU → **2,000–10,000 concurrent users in audio rooms**

Current system capacity (both regions):
- 30 rooms per worker × 3 workers × 15 max instances × 2 regions = **2,700 rooms**
- Wait: `MAX_ROOMS_PER_WORKER=100` × 3 workers × 15 instances × 2 regions = **9,000 rooms**
- At ~10 concurrent users per room average → **~90,000 concurrent listeners**

**The system can handle 1M MAU if peak concurrency stays under ~90,000 listeners.** The main bottleneck is the `c7i.xlarge` CPU under heavy WebRTC encode/decode. Monitor `WorkerCPU` — if it stays under 60% at peak, you're fine.

---

## 4. Deployment Guide (New AWS Account)

### 4.1 Prerequisites

Install these on your local machine:

```bash
# Terraform 1.10+ (required for S3 native locking)
# Download from: https://developer.hashicorp.com/terraform/install
terraform version  # verify >= 1.10.0

# AWS CLI v2
aws --version

# Docker (for building/pushing the MSAB image)
docker --version

# Git
git --version
```

### 4.2 AWS Account Setup

1. Go to https://aws.amazon.com → **Create a new account**
2. Enter email, account name, payment method
3. Choose **Basic support** (free)
4. Wait for activation email (usually <30 minutes)

### 4.3 Create IAM Admin User

Never use the root account for deployments.

1. Sign in to AWS Console → **IAM** → **Users** → **Create user**
2. Username: `terraform-deployer`
3. Check **"Provide user access to the AWS Management Console"** → No (CLI only)
4. **Permissions** → Attach policies directly → `AdministratorAccess`
   - For production, scope this down after initial deploy
5. Create user → **Security credentials** tab → **Create access key**
6. Choose **CLI** → Create → Download or copy the Access Key ID + Secret

Configure your local CLI:
```bash
aws configure
# AWS Access Key ID: <paste key>
# AWS Secret Access Key: <paste secret>
# Default region: ap-south-1
# Default output format: json
```

Verify:
```bash
aws sts get-caller-identity
# Should show your new account ID and the IAM user ARN
```

**Record your AWS account ID** — you'll need it in the next step.

### 4.4 Bootstrap State Backend

Before `terraform init`, the S3 bucket must exist.

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET_NAME="flylive-audio-tfstate-${ACCOUNT_ID}"
REGION="ap-south-1"

# Create S3 bucket
aws s3api create-bucket \
  --bucket "$BUCKET_NAME" \
  --region "$REGION" \
  --create-bucket-configuration LocationConstraint="$REGION"

# Enable versioning (allows recovering from bad applies)
aws s3api put-bucket-versioning \
  --bucket "$BUCKET_NAME" \
  --versioning-configuration Status=Enabled

# Enable server-side encryption
aws s3api put-bucket-encryption \
  --bucket "$BUCKET_NAME" \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'

# Block all public access
aws s3api put-public-access-block \
  --bucket "$BUCKET_NAME" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,\
    BlockPublicPolicy=true,RestrictPublicBuckets=true

echo "Bucket created: $BUCKET_NAME"
echo "Account ID: $ACCOUNT_ID"
```

### 4.5 Update main.tf with New Bucket Name

Open `terraform/main.tf` and update the backend block:

```hcl
backend "s3" {
  bucket       = "flylive-audio-tfstate-<YOUR_NEW_ACCOUNT_ID>"  # ← change this
  key          = "phase1/terraform.tfstate"
  region       = "ap-south-1"
  use_lockfile = true
  encrypt      = true
}
```

### 4.6 Generate SSH Key Pair

```bash
ssh-keygen -t ed25519 -f ~/.ssh/flylive_deploy -C "flylive-deploy"
# Creates: ~/.ssh/flylive_deploy (private) + ~/.ssh/flylive_deploy.pub (public)
```

The public key path is passed to Terraform as `ssh_public_key_path`. With SSM Session Manager enabled, you won't normally need SSH — but the key pair is required by the Launch Template.

### 4.7 Build and Push Docker Image

Before Terraform creates the ASG, ECR must exist and have at least one image.

**Step A: Apply ECR only first**

```bash
cd terraform/

# Initialize Terraform
terraform init

# Apply only the ECR module
terraform apply -target=module.ecr

# Get the ECR URL
ECR_URL=$(terraform output -raw ecr_repository_url)
echo "ECR URL: $ECR_URL"
```

**Step B: Build and push MSAB image**

```bash
# Authenticate Docker with ECR
aws ecr get-login-password --region ap-south-1 | \
  docker login --username AWS --password-stdin \
  "$(echo $ECR_URL | cut -d'/' -f1)"

# Build the image from the repo root
cd ..  # back to mediasoup-socket-io-audio-broadcasting-server/
docker build -t "$ECR_URL:latest" .

# Push
docker push "$ECR_URL:latest"
```

### 4.8 Prepare Variables

Create `terraform/terraform.tfvars` (this file is gitignored):

```hcl
# Generate with: openssl rand -hex 32
jwt_secret              = "your-64-char-hex-string-here"
laravel_internal_key    = "your-64-char-hex-string-here"
session_secret          = "your-64-char-hex-string-here"
redis_auth_token        = "your-redis-password-min16chars"   # no @, /, or quotes

# Cloudflare Realtime TURN (get from Cloudflare dashboard)
cloudflare_turn_api_key = "your-cloudflare-turn-api-key"
cloudflare_turn_key_id  = "your-cloudflare-turn-key-id"

# Path to your SSH public key
ssh_public_key_path = "~/.ssh/flylive_deploy.pub"
```

Generate secrets:
```bash
openssl rand -hex 32  # run 3 times for jwt_secret, laravel_internal_key, session_secret
openssl rand -base64 24 | tr -d '+/=' | head -c 30  # for redis_auth_token
```

### 4.9 Run Terraform Apply

**IMPORTANT: ACM certificates and DNS validation run in parallel. You have a ~10-minute window to add the CNAME records to Cloudflare (§ 5.1).**

```bash
cd terraform/

# Verify plan (reads your tfvars automatically)
terraform plan -out=tfplan

# Review the plan — ensure it shows ~60–80 resources to add

# Apply (this will block on ACM validation — keep your Cloudflare tab open)
terraform apply tfplan
```

When you see output like:
```
module.ssl_mumbai.aws_acm_certificate.main: Creation complete
module.ssl_mumbai.aws_acm_certificate_validation.main: Still creating... [0s elapsed]
```

Immediately go to § 5.1 and add the Cloudflare CNAME records. The apply will unblock once DNS propagates and ACM validates (typically 2–5 minutes after the records are created).

### 4.10 Post-Apply Validation

```bash
# Get all outputs
terraform output

# Key values:
terraform output global_accelerator_dns  # → point your domain here
terraform output nlb_dns_mumbai
terraform output nlb_dns_frankfurt
terraform output sns_topic_arn           # → give this to Laravel backend
terraform output ecr_repository_url
```

**Check ASG instances are healthy:**
```bash
# Mumbai
aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names "$(terraform output -raw asg_name_mumbai)" \
  --region ap-south-1 \
  --query 'AutoScalingGroups[0].Instances[*].[InstanceId,LifecycleState,HealthStatus]' \
  --output table

# Both instances should show: InService | Healthy
```

**Test health endpoints:**
```bash
# Replace with your actual NLB DNS names
curl -k https://<nlb-mumbai-dns>/health
# Expected: {"status":"ok",...}

curl -k https://<nlb-frankfurt-dns>/health
```

**Test via GA (after DNS propagates):**
```bash
curl https://audio.flyliveapp.com/health
```

### 4.11 Give SNS ARN to Laravel

Laravel needs the SNS topic ARN to publish events:
```bash
terraform output sns_topic_arn
# arn:aws:sns:ap-south-1:<account>:flylive-audio-msab-events
```

Set this in Laravel's `.env`:
```
AWS_SNS_MSAB_TOPIC_ARN=arn:aws:sns:ap-south-1:<account>:flylive-audio-msab-events
```

Laravel's IAM user (separate, for the Laravel backend) needs `sns:Publish` permission on this topic ARN.

### 4.12 Deploying Updates (New Docker Image)

```bash
# 1. Build and push new image with a git-sha tag
GIT_SHA=$(git rev-parse --short HEAD)
docker build -t "$ECR_URL:sha-${GIT_SHA}" .
docker push "$ECR_URL:sha-${GIT_SHA}"

# 2. Update Terraform image_tag variable (or set via tfvars)
# The autoscaling modules accept an image_tag variable (default: "latest")

# 3. Apply to update the launch template
terraform apply -var="image_tag=sha-${GIT_SHA}"

# 4. Trigger instance refresh (rolling deploy, 50% min healthy)
aws autoscaling start-instance-refresh \
  --auto-scaling-group-name "$(terraform output -raw asg_name_mumbai)" \
  --region ap-south-1

aws autoscaling start-instance-refresh \
  --auto-scaling-group-name "$(terraform output -raw asg_name_frankfurt)" \
  --region eu-central-1
```

### 4.13 Shell Access to Instances (No SSH)

```bash
# List running instances
aws ec2 describe-instances \
  --filters "Name=tag:Project,Values=flylive-audio" "Name=instance-state-name,Values=running" \
  --query 'Reservations[*].Instances[*].[InstanceId,PublicIpAddress,Placement.AvailabilityZone]' \
  --region ap-south-1 --output table

# Start SSM session (browser-like terminal in your local shell)
aws ssm start-session \
  --target <instance-id> \
  --region ap-south-1
```

---

## 5. Cloudflare Setup

### 5.1 ACM Certificate DNS Validation (Critical — Do This During Apply)

During `terraform apply`, after each `aws_acm_certificate.main` is created, run:

```bash
# Mumbai cert validation records
aws acm describe-certificate \
  --certificate-arn "$(terraform output -json | jq -r '.certificate_arn_mumbai.value // empty')" \
  --region ap-south-1 \
  --query 'Certificate.DomainValidationOptions[*].[DomainName,ResourceRecord.Name,ResourceRecord.Value]' \
  --output table
```

> If that output key doesn't exist, get the cert ARN from the AWS Console → ACM → ap-south-1 → Certificates.

For each row in the output, add a **CNAME record in Cloudflare**:

| Cloudflare field | Value |
|-----------------|-------|
| Type | CNAME |
| Name | `<ResourceRecord.Name>` (strip the trailing `.`) |
| Target | `<ResourceRecord.Value>` (strip the trailing `.`) |
| Proxy status | **DNS only** (gray cloud — NOT proxied) |
| TTL | Auto |

Do the same for Frankfurt's certificate (run the command with `--region eu-central-1`).

You typically get 4 CNAME records total (2 certs × 2 domain names). Some may be identical if ACM deduplicates across regions.

### 5.2 Main Domain DNS

After `terraform apply` completes:

```bash
terraform output global_accelerator_dns
# e.g., a1b2c3d4e5f6g7h8.awsglobalaccelerator.com

terraform output global_accelerator_ips
# e.g., ["1.2.3.4", "5.6.7.8"]
```

In Cloudflare DNS:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| CNAME | `audio` | `<global_accelerator_dns>` | **DNS only** (gray cloud) |

**Why DNS only (not proxied)?** Global Accelerator uses anycast IPs for latency-based routing. If Cloudflare proxies the request, GA sees Cloudflare's IP instead of the user's, breaking geo-routing. Additionally, WebRTC UDP traffic goes directly to EC2 IPs — proxying only the WebSocket through Cloudflare creates an inconsistency.

Alternative: point `audio` to the GA static anycast IPs as two A records (IPs never change for the life of the accelerator):
```
A  audio  1.2.3.4   DNS only
A  audio  5.6.7.8   DNS only
```

### 5.3 SSL/TLS Mode

In Cloudflare dashboard → SSL/TLS → Overview:
- Set mode to **Full (strict)** if Cloudflare is proxying (though we recommend DNS only for audio)
- If DNS only: this setting is irrelevant — TLS is handled entirely by ACM on the NLB

### 5.4 Cloudflare Realtime TURN Setup

MSAB uses Cloudflare's TURN service for users who can't do direct WebRTC (behind strict firewalls).

1. Cloudflare Dashboard → **Workers & Pages** → **Cloudflare Calls** (or search for "Realtime")
2. **Create a new TURN key** → get the `key_id` and `api_key`
3. Set in `terraform.tfvars`:
   ```hcl
   cloudflare_turn_key_id  = "the-hex-key-id"
   cloudflare_turn_api_key = "the-api-bearer-token"
   ```
4. MSAB fetches short-lived TURN credentials from the Cloudflare API at room creation time using these values

### 5.5 Cloudflare Page Rules / Cache Rules

Add a **Cache Rule** to bypass cache for the audio subdomain:
- If hostname equals `audio.flyliveapp.com` → **Cache: Bypass**

This prevents Cloudflare from accidentally caching WebSocket upgrade responses or API responses.

---

## 6. GitHub CI/CD Setup

### 6.1 IAM User for GitHub Actions

Create a dedicated IAM user for CI/CD:

```bash
# Create user
aws iam create-user --user-name github-actions-flylive

# Attach ECR push policy
aws iam attach-user-policy \
  --user-name github-actions-flylive \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser

# Create access key
aws iam create-access-key --user-name github-actions-flylive
# SAVE the output — this is the only time you see the secret key
```

Additional permissions needed for triggering ASG instance refresh:
```bash
cat > /tmp/asg-refresh-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "autoscaling:StartInstanceRefresh",
      "autoscaling:DescribeInstanceRefreshes",
      "autoscaling:DescribeAutoScalingGroups"
    ],
    "Resource": "*"
  }]
}
EOF

aws iam put-user-policy \
  --user-name github-actions-flylive \
  --policy-name asg-refresh \
  --policy-document file:///tmp/asg-refresh-policy.json
```

### 6.2 GitHub Repository Secrets

In your GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret name | Value |
|------------|-------|
| `AWS_ACCESS_KEY_ID` | From step 6.1 |
| `AWS_SECRET_ACCESS_KEY` | From step 6.1 |
| `AWS_ACCOUNT_ID` | Your AWS account ID |
| `ECR_REPOSITORY` | `flylive-audio/msab` |

### 6.3 Example GitHub Actions Workflow

Create `.github/workflows/deploy.yml` in the MSAB repo:

```yaml
name: Deploy MSAB

on:
  push:
    branches: [main]

env:
  AWS_REGION: ap-south-1
  ECR_REGISTRY: ${{ secrets.AWS_ACCOUNT_ID }}.dkr.ecr.ap-south-1.amazonaws.com

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        id: login-ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build, tag, and push image
        id: build
        env:
          IMAGE_TAG: sha-${{ github.sha }}
        run: |
          docker build -t $ECR_REGISTRY/${{ secrets.ECR_REPOSITORY }}:$IMAGE_TAG .
          docker push $ECR_REGISTRY/${{ secrets.ECR_REPOSITORY }}:$IMAGE_TAG
          echo "image_tag=$IMAGE_TAG" >> $GITHUB_OUTPUT

      - name: Trigger ASG instance refresh — Mumbai
        run: |
          aws autoscaling start-instance-refresh \
            --auto-scaling-group-name flylive-audio-asg-mumbai \
            --region ap-south-1 \
            --preferences '{"MinHealthyPercentage":50,"InstanceWarmup":300}'

      - name: Trigger ASG instance refresh — Frankfurt
        run: |
          aws autoscaling start-instance-refresh \
            --auto-scaling-group-name flylive-audio-asg-frankfurt \
            --region eu-central-1 \
            --preferences '{"MinHealthyPercentage":50,"InstanceWarmup":300}'
```

> **Note:** The ASG name in `start-instance-refresh` must match the actual name created by Terraform. Get it from `terraform output asg_name_mumbai` / `asg_name_frankfurt`.

> **Known gap:** This workflow triggers the refresh but the new Launch Template must already point to the new image tag. Currently, updating the image tag requires a Terraform apply. A common pattern is to store the image tag as a Launch Template user-data override rather than baking it into the template — this allows the refresh without a Terraform run. This is a future improvement.

### 6.4 Verify a Deployment

```bash
# Check instance refresh status
aws autoscaling describe-instance-refreshes \
  --auto-scaling-group-name "$(terraform output -raw asg_name_mumbai)" \
  --region ap-south-1 \
  --query 'InstanceRefreshes[0].[Status,PercentageComplete,InstancesToUpdate]' \
  --output table
```

Status progresses: `Pending` → `InProgress` → `Successful`. During `InProgress`, at least 1 instance (50% of desired=2) is always healthy and serving traffic.

---

## Appendix: Quick Reference

### Key Domain
- Audio server: `audio.flyliveapp.com`
- Health check: `https://audio.flyliveapp.com/health`

### Ports
| Port | Protocol | Purpose |
|------|----------|---------|
| 443 | TCP/TLS | WebSocket signaling (via GA → NLB) |
| 3030 | TCP | Direct app port (health checks, internal) |
| 10000–59999 | UDP | WebRTC media (direct to EC2) |
| 10000–59999 | TCP | WebRTC TCP fallback |
| 40000–49999 | UDP | SFU cascade (intended VPC-internal) |
| 6379 | TCP | Redis (VPC-internal only) |

### Secrets Checklist
- [ ] `jwt_secret` — 64 hex chars, matches Laravel `MSAB_JWT_SECRET`
- [ ] `laravel_internal_key` — 64 hex chars, matches Laravel `MSAB_INTERNAL_KEY`
- [ ] `session_secret` — 64 hex chars (**do not leave empty**)
- [ ] `redis_auth_token` — 16–128 chars, no `@`, `/`, or quotes
- [ ] `cloudflare_turn_api_key` — from Cloudflare dashboard
- [ ] `cloudflare_turn_key_id` — from Cloudflare dashboard

### Cost Estimate (steady state, both regions)

| Resource | Count | Monthly est. |
|----------|-------|-------------|
| c7i.xlarge EC2 | 4 (2/region) | ~$500 |
| cache.r7g.large ElastiCache | 4 (2 nodes × 2 regions) | ~$600 |
| NLB | 2 | ~$30 |
| Global Accelerator | 1 | ~$18 + data transfer |
| ECR storage | ~few GB | <$5 |
| CloudWatch | metrics + dashboard | ~$10 |
| SNS | low volume | <$5 |
| **Total** | | **~$1,165/month** |

This scales up when ASGs add instances at peak. Each additional `c7i.xlarge` ≈ $125/month.

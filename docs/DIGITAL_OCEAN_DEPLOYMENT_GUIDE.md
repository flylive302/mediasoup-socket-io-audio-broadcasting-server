# Digital Ocean Deployment Guide - FlyLive Audio Server

> **Complete Step-by-Step Deployment for Horizontal Scaling**  
> _Backend: Laravel Cloud | Frontend: NuxtHub | Audio Server: Digital Ocean_

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Understanding the Architecture](#2-understanding-the-architecture)
3. [Pre-Deployment Checklist](#3-pre-deployment-checklist)
4. [Option A: Digital Ocean Droplets (Recommended for Production)](#4-option-a-digital-ocean-droplets-recommended-for-production)
5. [Option B: Digital Ocean Kubernetes (DOKS)](#5-option-b-digital-ocean-kubernetes-doks)
6. [Setting Up Managed Redis](#6-setting-up-managed-redis)
7. [Load Balancer Configuration](#7-load-balancer-configuration)
8. [Horizontal Scaling Configuration](#8-horizontal-scaling-configuration)
9. [Environment Variables Reference](#9-environment-variables-reference)
10. [SSL/TLS Configuration](#10-ssltls-configuration)
11. [Connecting to Laravel Cloud Backend](#11-connecting-to-laravel-cloud-backend)
12. [Connecting to NuxtHub Frontend](#12-connecting-to-nuxthub-frontend)
13. [Health Checks & Monitoring](#13-health-checks--monitoring)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Prerequisites

Before starting, ensure you have:

- [ ] **Digital Ocean Account** with billing enabled
- [ ] **doctl CLI** installed and authenticated (`doctl auth init`)
- [ ] **GitHub Repository** with the audio server code
- [ ] **Laravel Cloud** backend deployed and accessible
- [ ] **NuxtHub** frontend deployed
- [ ] **Domain name** for the audio server (e.g., `audio.flylive.app`)
- [ ] **SSH key** added to Digital Ocean

### Install doctl CLI

```bash
# macOS
brew install doctl

# Ubuntu/Debian
snap install doctl

# Windows
scoop install doctl

# Authenticate
doctl auth init
```

---

## 2. Understanding the Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (NuxtHub)                                  │
│                        https://app.flylive.app                                │
└─────────────────────────────────┬────────────────────────────────────────────┘
                                  │ WebSocket + WebRTC
                                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                    DIGITAL OCEAN LOAD BALANCER                                │
│                      https://audio.flylive.app                                │
│                    (Sticky Sessions Enabled)                                  │
└─────────────────────────────────┬────────────────────────────────────────────┘
                                  │
            ┌─────────────────────┼─────────────────────┐
            ▼                     ▼                     ▼
     ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
     │  Droplet #1  │      │  Droplet #2  │      │  Droplet #N  │
     │ Audio Server │      │ Audio Server │      │ Audio Server │
     │  (4+ vCPU)   │      │  (4+ vCPU)   │      │  (4+ vCPU)   │
     └──────┬───────┘      └──────┬───────┘      └──────┬───────┘
            │                     │                     │
            └─────────────────────┼─────────────────────┘
                                  ▼
                     ┌────────────────────────┐
                     │   MANAGED REDIS (HA)   │
                     │   Pub/Sub + Sessions   │
                     └────────────────────────┘
                                  │
                                  ▼
                     ┌────────────────────────┐
                     │    LARAVEL CLOUD       │
                     │  https://api.flylive   │
                     └────────────────────────┘
```

> [!IMPORTANT]
> **Why Droplets over App Platform?**
> Digital Ocean App Platform does NOT support UDP ports required for WebRTC audio streaming. You MUST use Droplets for production media servers.

---

## 3. Pre-Deployment Checklist

### 3.1 Generate Internal API Key

This key is shared between the Audio Server and Laravel backend:

```bash
# Generate a secure 32+ character key
openssl rand -base64 32
# Example output: 7bX9kL2mN4pQ8rS1tU6vW0xY3zA5bC7dE9fG
```

Save this key - you'll need it for both Laravel Cloud and Audio Server configuration.

### 3.2 Prepare Repository

Ensure your repository has:

- `docker/Dockerfile` - Multi-stage production build
- `.env.example` - Environment template
- `package.json` with build scripts

---

## 4. Option A: Digital Ocean Droplets (Recommended for Production)

### Step 4.1: Create Droplet via Dashboard

1. **Navigate to Digital Ocean Dashboard**
   - Go to [cloud.digitalocean.com](https://cloud.digitalocean.com)
   - Log in to your account

2. **Click "Create" → "Droplets"**

   ![Create Droplet Button](https://docs.digitalocean.com/screenshots/droplets/create/create-button.png)

3. **Configure Droplet Settings:**

   | Setting            | Recommended Value                                       |
   | ------------------ | ------------------------------------------------------- |
   | **Region**         | Choose closest to your users (e.g., `SGP1` for Asia)    |
   | **Datacenter**     | Default                                                 |
   | **Image**          | Marketplace → **Docker on Ubuntu 22.04**                |
   | **Size**           | CPU-Optimized: **c-4** (4 vCPU, 8GB RAM) for production |
   | **Backups**        | Enable (recommended)                                    |
   | **VPC**            | Create new or use existing                              |
   | **Authentication** | SSH Key (recommended)                                   |
   | **Hostname**       | `audio-server-01`                                       |
   | **Tags**           | `audio-server`, `production`                            |

4. **Click "Create Droplet"**

### Step 4.2: Create Firewall via Dashboard

1. **Navigate to Networking → Firewalls**
   - Click "Create Firewall"

2. **Configure Inbound Rules:**

   | Type   | Protocol | Port Range  | Sources                                          | Why This Source?                                                                                 |
   | ------ | -------- | ----------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
   | SSH    | TCP      | 22          | **Your Admin IP Only** (e.g., `203.0.113.50/32`) | Security: Only you/your team should SSH. Get your IP at [whatismyip.com](https://whatismyip.com) |
   | HTTP   | TCP      | 3030        | `0.0.0.0/0` (All)                                | **End users worldwide** connect via Socket.IO from browsers/mobile apps                          |
   | Custom | TCP      | 10000-59999 | `0.0.0.0/0` (All)                                | WebRTC media streams from **end users' devices** globally                                        |
   | Custom | UDP      | 10000-59999 | `0.0.0.0/0` (All)                                | WebRTC media streams from **end users' devices** globally                                        |

   > [!NOTE]
   > **Why allow all IPs (0.0.0.0/0) for ports 3030 and RTC ports?**
   >
   > - Your **mobile app users** and **web users** connect directly to the audio server from their devices
   > - These users are located worldwide with unpredictable IP addresses
   > - You do **NOT** need to whitelist Laravel Cloud or NuxtHub IPs:
   >   - **Laravel Cloud**: The audio server makes _outbound_ requests to Laravel (already allowed by outbound rules)
   >   - **NuxtHub**: NuxtHub is static hosting; user browsers make the connections, not NuxtHub servers

3. **Configure Outbound Rules:**
   - Allow all outbound TCP (for Laravel API calls)
   - Allow all outbound UDP (for WebRTC if needed)

4. **Apply to Droplets:**
   - Select your audio server droplet(s)
   - Name: `audio-server-firewall`
   - Click "Create Firewall"

5. **Optional: Add Team IPs for SSH**
   - If you have a team, add each team member's IP to the SSH rule
   - Or use a VPN and whitelist only the VPN's exit IP

### Step 4.3: SSH into Droplet and Deploy

```bash
# SSH into your droplet
ssh root@YOUR_DROPLET_IP

# Clone the repository
git clone https://github.com/YOUR_ORG/flylive-audio-server.git
cd flylive-audio-server

# Create production environment file
cat > .env << 'EOF'
# Server Configuration
NODE_ENV=production
PORT=3030
LOG_LEVEL=info

# Redis Configuration (Get from Managed Redis - see Step 6)
REDIS_HOST=your-redis-private-ip.db.ondigitalocean.com
REDIS_PORT=25060
REDIS_PASSWORD=your-redis-password
REDIS_DB=3

# Laravel Integration
LARAVEL_API_URL=https://api.flylive.app
LARAVEL_INTERNAL_KEY=your_32_character_internal_key

# MediaSoup Configuration
MEDIASOUP_LISTEN_IP=0.0.0.0
MEDIASOUP_ANNOUNCED_IP=YOUR_DROPLET_PUBLIC_IP
MEDIASOUP_RTC_MIN_PORT=10000
MEDIASOUP_RTC_MAX_PORT=59999

# CORS (Your frontend domains)
CORS_ORIGINS=https://app.flylive.app,https://www.flylive.app
EOF

# Replace placeholders with actual values
nano .env  # Edit with your values

# Build Docker image
docker build -t audio-server -f docker/Dockerfile .

# Run container with host networking for UDP
docker run -d \
  --name audio-server \
  --restart unless-stopped \
  --network host \
  --env-file .env \
  audio-server

# Verify it's running
docker ps
docker logs -f audio-server

# Test health endpoint
curl http://localhost:3030/health
```

> [!TIP]
> Using `--network host` is recommended for WebRTC servers as it provides direct access to UDP ports without NAT issues.

### Step 4.4: Create Additional Droplets (Horizontal Scaling)

For horizontal scaling, repeat steps 4.1-4.3 for each additional server:

- `audio-server-02`
- `audio-server-03`
- etc.

Each droplet needs:

- Same firewall rules
- Same `.env` configuration (except `MEDIASOUP_ANNOUNCED_IP` which should be each droplet's public IP)
- Same Docker deployment

---

## 5. Option B: Digital Ocean Kubernetes (DOKS)

For advanced horizontal scaling with auto-scaling capabilities.

### Step 5.1: Create Kubernetes Cluster

1. **Navigate to Kubernetes in Dashboard**
   - Click "Create" → "Kubernetes"

2. **Configure Cluster:**

   | Setting       | Value                                             |
   | ------------- | ------------------------------------------------- |
   | **Region**    | `SGP1` (or closest to users)                      |
   | **Version**   | Latest stable (1.28+)                             |
   | **Node Pool** | CPU-Optimized, 4 vCPU, 2-5 nodes for auto-scaling |
   | **Name**      | `audio-cluster`                                   |

3. **Create Cluster** (takes ~10 minutes)

4. **Download kubeconfig:**
   ```bash
   doctl kubernetes cluster kubeconfig save audio-cluster
   ```

### Step 5.2: Create Kubernetes Manifests

Create `k8s/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: audio-server
  labels:
    app: audio-server
spec:
  replicas: 2
  selector:
    matchLabels:
      app: audio-server
  template:
    metadata:
      labels:
        app: audio-server
    spec:
      hostNetwork: true # Required for WebRTC
      dnsPolicy: ClusterFirstWithHostNet
      containers:
        - name: audio-server
          image: YOUR_REGISTRY/audio-server:latest
          ports:
            - containerPort: 3030
              hostPort: 3030
          env:
            - name: NODE_ENV
              value: "production"
            - name: PORT
              value: "3030"
            - name: REDIS_HOST
              valueFrom:
                secretKeyRef:
                  name: audio-server-secrets
                  key: redis-host
            - name: REDIS_PORT
              value: "25060"
            - name: REDIS_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: audio-server-secrets
                  key: redis-password
            - name: LARAVEL_API_URL
              value: "https://api.flylive.app"
            - name: LARAVEL_INTERNAL_KEY
              valueFrom:
                secretKeyRef:
                  name: audio-server-secrets
                  key: laravel-internal-key
            - name: MEDIASOUP_LISTEN_IP
              value: "0.0.0.0"
            - name: MEDIASOUP_ANNOUNCED_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.hostIP
          livenessProbe:
            httpGet:
              path: /health
              port: 3030
            initialDelaySeconds: 15
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /health
              port: 3030
            initialDelaySeconds: 5
            periodSeconds: 5
          resources:
            requests:
              cpu: "2000m"
              memory: "4Gi"
            limits:
              cpu: "4000m"
              memory: "8Gi"
---
apiVersion: v1
kind: Service
metadata:
  name: audio-server
spec:
  type: LoadBalancer
  selector:
    app: audio-server
  ports:
    - port: 3030
      targetPort: 3030
      name: http
```

### Step 5.3: Deploy to Kubernetes

```bash
# Create secrets
kubectl create secret generic audio-server-secrets \
  --from-literal=redis-host="your-redis-host" \
  --from-literal=redis-password="your-redis-password" \
  --from-literal=laravel-internal-key="your-internal-key"

# Apply deployment
kubectl apply -f k8s/deployment.yaml

# Verify
kubectl get pods
kubectl get services
```

---

## 6. Setting Up Managed Redis

### Step 6.1: Create Managed Redis via Dashboard

1. **Navigate to Databases**
   - Click "Create" → "Databases"

2. **Configure Database:**

   | Setting                   | Value                                                   |
   | ------------------------- | ------------------------------------------------------- |
   | **Engine**                | Redis                                                   |
   | **Version**               | 7                                                       |
   | **Region**                | Same as Droplets (e.g., `SGP1`)                         |
   | **Cluster Configuration** | 1 Node (Scale to 2-3 for HA)                            |
   | **Node Size**             | `db-s-1vcpu-1gb` (MVP) or `db-s-2vcpu-4gb` (Production) |
   | **VPC**                   | Same VPC as Droplets                                    |
   | **Database Name**         | `audio-redis`                                           |

3. **Click "Create Database Cluster"**

### Step 6.2: Configure Connection Settings

After creation, get connection details:

1. **Navigate to your Redis cluster**
2. **Copy the connection settings:**
   - Host (Private Network): `private-audio-redis-do-user-xxx.db.ondigitalocean.com`
   - Host (Public): `audio-redis-do-user-xxx.db.ondigitalocean.com`
   - Port: `25060`
   - Password: (shown in dashboard)

3. **Add Trusted Sources:**
   - Add your audio server Droplets to trusted sources
   - Or add the VPC network

### Step 6.3: Test Connection

```bash
# From your audio server droplet
redis-cli -h REDIS_HOST -p 25060 -a REDIS_PASSWORD PING
# Should return: PONG
```

---

## 7. Load Balancer Configuration

### Step 7.1: Create Load Balancer via Dashboard

1. **Navigate to Networking → Load Balancers**
   - Click "Create Load Balancer"

2. **Configure Load Balancer:**

   | Setting              | Value                   |
   | -------------------- | ----------------------- |
   | **Region**           | Same as Droplets        |
   | **VPC**              | Same as Droplets        |
   | **Forwarding Rules** | HTTPS 443 → HTTP 3030   |
   | **Algorithm**        | Least Connections       |
   | **Sticky Sessions**  | **ENABLED** (Critical!) |
   | **Cookie Name**      | `AUDIO_SERVER_SESSION`  |
   | **TTL**              | 3600 (1 hour)           |

3. **Health Checks:**

   | Setting                 | Value      |
   | ----------------------- | ---------- |
   | **Protocol**            | HTTP       |
   | **Port**                | 3030       |
   | **Path**                | `/health`  |
   | **Interval**            | 10 seconds |
   | **Timeout**             | 5 seconds  |
   | **Healthy Threshold**   | 2          |
   | **Unhealthy Threshold** | 3          |

4. **Add Droplets:**
   - Select all audio server droplets

5. **Name:** `audio-lb`

6. **Click "Create Load Balancer"**

> [!CAUTION]
> **Sticky Sessions are CRITICAL!** Socket.IO maintains persistent connections. Without sticky sessions, users will be randomly routed to different servers, breaking their WebSocket connections.

### Step 7.2: Configure SSL Certificate

1. **In Load Balancer settings, go to "Settings"**
2. **Edit Forwarding Rules:**
   - Click "Edit"
   - Change Entry Protocol to "HTTPS"
   - Select or create certificate

3. **Create Certificate (if needed):**
   - Source: Let's Encrypt
   - Domain: `audio.flylive.app`
   - Verify domain ownership

---

## 8. Horizontal Scaling Configuration

### 8.1 Requirements for Horizontal Scaling

For the audio server to scale horizontally, you need:

1. **Shared Redis** - All instances use the same Redis for:
   - Session storage
   - Room state
   - Pub/Sub for cross-instance communication

2. **Sticky Sessions** - Load balancer must route same user to same instance

3. **Socket.IO Adapter** - Already configured to use Redis adapter

### 8.2 Manual Scaling

Add more droplets when load increases:

```bash
# Create new droplet
doctl compute droplet create audio-server-03 \
  --size c-4 \
  --image docker-22-04 \
  --region sgp1 \
  --vpc-uuid YOUR_VPC_UUID \
  --tag-name audio-server

# Get new droplet IP
doctl compute droplet list --tag-name audio-server

# SSH and deploy (same as Step 4.3)
ssh root@NEW_DROPLET_IP
# ... deploy Docker container

# Add to load balancer
doctl compute load-balancer add-droplets \
  YOUR_LB_ID \
  --droplet-ids NEW_DROPLET_ID
```

### 8.3 Auto-Scaling with Kubernetes (DOKS)

If using Kubernetes, configure Horizontal Pod Autoscaler:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: audio-server-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: audio-server
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

```bash
kubectl apply -f k8s/hpa.yaml
```

---

## 9. Environment Variables Reference

| Variable                 | Required | Example                             | Description                |
| ------------------------ | -------- | ----------------------------------- | -------------------------- |
| `NODE_ENV`               | Yes      | `production`                        | Environment mode           |
| `PORT`                   | Yes      | `3030`                              | Server port                |
| `LOG_LEVEL`              | No       | `info`                              | Logging verbosity          |
| `REDIS_HOST`             | Yes      | `private-xxx.db.ondigitalocean.com` | Redis hostname             |
| `REDIS_PORT`             | Yes      | `25060`                             | Redis port                 |
| `REDIS_PASSWORD`         | Yes      | `xxxxx`                             | Redis password             |
| `REDIS_DB`               | No       | `3`                                 | Redis database number      |
| `LARAVEL_API_URL`        | Yes      | `https://api.flylive.app`           | Laravel Cloud URL          |
| `LARAVEL_INTERNAL_KEY`   | Yes      | `32+char key`                       | Shared secret with Laravel |
| `MEDIASOUP_LISTEN_IP`    | Yes      | `0.0.0.0`                           | Listen on all interfaces   |
| `MEDIASOUP_ANNOUNCED_IP` | Yes      | `(Public IP)`                       | Server's public IP         |
| `MEDIASOUP_RTC_MIN_PORT` | No       | `10000`                             | RTC port range start       |
| `MEDIASOUP_RTC_MAX_PORT` | No       | `59999`                             | RTC port range end         |
| `CORS_ORIGINS`           | No       | `https://app.flylive.app`           | Allowed origins            |

---

## 10. SSL/TLS Configuration

### Option A: SSL Termination at Load Balancer (Recommended)

The load balancer handles SSL, audio servers run HTTP internally.

1. Create SSL certificate in DO Dashboard
2. Configure load balancer: HTTPS → HTTP

### Option B: Direct SSL on Servers

If not using a load balancer:

```bash
# Install certbot
apt update && apt install -y certbot

# Get certificate
certbot certonly --standalone -d audio.flylive.app

# Update .env
echo "SSL_KEY_PATH=/etc/letsencrypt/live/audio.flylive.app/privkey.pem" >> .env
echo "SSL_CERT_PATH=/etc/letsencrypt/live/audio.flylive.app/fullchain.pem" >> .env

# Restart container
docker restart audio-server
```

---

## 11. Connecting to Laravel Cloud Backend

### 11.1 Configure Laravel Cloud

In your Laravel Cloud environment, add:

```env
# Laravel Cloud Environment Variables
MSAB_INTERNAL_KEY=your_32_character_internal_key
AUDIO_SERVER_URL=https://audio.flylive.app
```

### 11.2 Verify Internal API Endpoints

Ensure Laravel has these endpoints implemented:

| Endpoint                          | Purpose                   |
| --------------------------------- | ------------------------- |
| `POST /internal/auth/validate`    | Validate user tokens      |
| `POST /internal/gifts/batch`      | Process gift transactions |
| `PUT /internal/rooms/{id}/status` | Update room status        |

### 11.3 Test Connection

```bash
# From audio server
curl -X POST https://api.flylive.app/internal/auth/validate \
  -H "Content-Type: application/json" \
  -H "X-Internal-Key: your_internal_key" \
  -d '{"token": "test_token"}'
```

---

## 12. Connecting to NuxtHub Frontend

### 12.1 Configure NuxtHub Environment

In your NuxtHub project's environment configuration:

```env
# NuxtHub Environment Variables
NUXT_PUBLIC_AUDIO_SERVER_URL=https://audio.flylive.app
```

### 12.2 Update nuxt.config.ts

```typescript
export default defineNuxtConfig({
  runtimeConfig: {
    public: {
      audioServerUrl:
        process.env.NUXT_PUBLIC_AUDIO_SERVER_URL || "https://audio.flylive.app",
    },
  },
});
```

### 12.3 Socket.IO Client Configuration

```typescript
// composables/useAudioSocket.ts
const config = useRuntimeConfig();

const socket = io(config.public.audioServerUrl, {
  auth: {
    token: userToken.value,
  },
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: 5,
  reconnectionDelay: 1000,
});
```

---

## 13. Health Checks & Monitoring

### 13.1 Health Check Endpoint

**GET `https://audio.flylive.app/health`**

```json
{
  "status": "ok",
  "uptime": 3600.5,
  "redis": "up",
  "workers": {
    "count": 4,
    "healthy": true
  },
  "rooms": 15,
  "timestamp": "2024-01-15T12:00:00.000Z"
}
```

### 13.2 Metrics Endpoint

**GET `https://audio.flylive.app/metrics`**

```json
{
  "system": {
    "uptime": 3600.5,
    "memory": {
      "rss": 104857600,
      "heapTotal": 52428800,
      "heapUsed": 41943040
    },
    "cpu": { "user": 1000000, "system": 500000 }
  },
  "application": {
    "rooms": 15,
    "activeWorkers": 4
  }
}
```

### 13.3 Set Up Digital Ocean Monitoring

1. **Enable Monitoring** on Droplets (during creation or via Settings)

2. **Create Alerts:**
   - Navigate to Monitoring → Alerts
   - Create alerts for:
     - CPU > 80% for 5 minutes
     - Memory > 90%
     - Load Balancer health check failures

### 13.4 Set Up Uptime Checks

1. **Navigate to Uptime → HTTP Checks**
2. **Create Check:**
   - URL: `https://audio.flylive.app/health`
   - Interval: 1 minute
   - Alert: Email/Slack

---

## 14. Troubleshooting

### Common Issues

#### "Connection refused" from frontend

**Cause:** CORS not configured or firewall blocking

**Fix:**

```bash
# Check CORS_ORIGINS includes your frontend domain
# Check firewall allows port 3030
```

#### No audio streaming (ICE failed)

**Cause:** `MEDIASOUP_ANNOUNCED_IP` not set correctly

**Fix:**

```bash
# Get your droplet's public IP
curl ifconfig.me

# Update .env
MEDIASOUP_ANNOUNCED_IP=YOUR_PUBLIC_IP

# Restart
docker restart audio-server
```

#### Redis connection timeout

**Cause:** Wrong host or not in trusted sources

**Fix:**

1. Use private hostname if in same VPC
2. Add droplet to Redis trusted sources
3. Check firewall allows port 25060

#### Load balancer health checks failing

**Check:**

```bash
# On server
curl http://localhost:3030/health

# Check logs
docker logs audio-server | tail -50
```

### Debug Commands

```bash
# Check container status
docker ps -a

# View logs
docker logs -f audio-server

# Check Redis connection
redis-cli -h REDIS_HOST -p 25060 -a PASSWORD PING

# Check open ports
netstat -tulpn | grep -E '(3030|10000)'

# Test from outside
curl -v https://audio.flylive.app/health
```

### Restart Procedures

```bash
# Graceful restart single server
docker stop audio-server
docker start audio-server

# Full restart (if needed)
docker stop audio-server
docker rm audio-server
docker run -d \
  --name audio-server \
  --restart unless-stopped \
  --network host \
  --env-file .env \
  audio-server
```

---

## Quick Reference: Complete Deployment Checklist

- [ ] **Infrastructure Setup**
  - [ ] Create CPU-Optimized Droplet(s) with Docker image
  - [ ] Configure firewall (TCP 3030, UDP/TCP 10000-59999)
  - [ ] Create Managed Redis cluster
  - [ ] Create Load Balancer with sticky sessions

- [ ] **Configuration**
  - [ ] Generate `LARAVEL_INTERNAL_KEY` and share with Laravel Cloud
  - [ ] Set `MEDIASOUP_ANNOUNCED_IP` to public IP on each server
  - [ ] Configure Redis connection (use private hostname)
  - [ ] Configure CORS origins for your frontend domain

- [ ] **Deployment**
  - [ ] Clone repository to each server
  - [ ] Create `.env` file with all variables
  - [ ] Build and run Docker container
  - [ ] Add droplets to load balancer

- [ ] **SSL & DNS**
  - [ ] Create/import SSL certificate
  - [ ] Configure load balancer HTTPS → HTTP
  - [ ] Point domain to load balancer IP

- [ ] **Verification**
  - [ ] Health check returns `status: ok`
  - [ ] Frontend can connect via Socket.IO
  - [ ] Audio streaming works (test with speakers)
  - [ ] Cross-server communication works via Redis

- [ ] **Monitoring**
  - [ ] Enable DO Monitoring on droplets
  - [ ] Configure CPU/Memory alerts
  - [ ] Set up uptime checks

---

## Related Documentation

- [Frontend Integration Guide](./FRONTEND_INTEGRATION.md) — Socket.IO events for NuxtHub
- [Laravel Requirements](./LARAVEL_REQUIREMENTS.md) — Backend API specifications

---

**Version:** 1.0  
**Last Updated:** December 2024  
**Author:** FlyLive Engineering Team

#!/bin/bash
# =============================================================================
# FlyLive Load-Generator — EC2 User Data (aws-production/08)
# =============================================================================
# Boots a throwaway, hand-triggered box that:
#   a-c. installs base packages, Node.js 22, AWS CLI v2
#   d.   resolves the staging MSAB target (explicit override, or tag discovery)
#   e.   fetches the internal auth key from SSM (never logged)
#   f-g. installs + configures Prometheus, scraping MSAB + its node_exporter
#   h.   installs a netem helper (NOT applied automatically)
#   i.   optionally delivers + npm-installs the load-harness
#   j.   writes /opt/loadgen-READY — the operator's single boot-complete signal
#        (docs/runbooks/msab-loadgen-campaign.md step 1's proof step)
#
# Variables are injected by Terraform templatefile() (modules/loadgen/main.tf):
#   project_name, environment, region, env_prefix, msab_target_host,
#   msab_app_port, internal_key_ssm_path, prometheus_version, harness_s3_uri
#
# ⚠️ TRAP (docs/reference/hard-won-gotchas.md "AWS Terraform stack"): this file
# is rendered by templatefile() BEFORE bash ever sees it. Every bash-only
# parameter expansion, positional arg, or indirect reference below has its
# dollar sign DOUBLED, so Terraform leaves a single literal one for bash to
# interpret; every real Terraform variable listed above is left as a normal
# single-dollar reference. A single- or double-quoted heredoc changes what
# BASH does, not what TERRAFORM does — Terraform scans the whole raw file text
# regardless of bash quoting. modules/autoscaling/user-data.sh is the proven
# precedent for this exact split. (This comment itself avoids spelling either
# form out literally, for the same reason — a literal example here would be
# parsed too.)
# =============================================================================

set -euo pipefail
exec > >(tee /var/log/loadgen-user-data.log) 2>&1

echo "=== Starting loadgen bootstrap (aws-production/08, ${env_prefix}) ==="

# --- a. Base packages ---
echo "--- Installing base packages (iproute2, unzip, curl, jq, build-essential) ---"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iproute2 unzip curl jq build-essential

# --- b. Node.js 22 (NodeSource) ---
echo "--- Installing Node.js 22 ---"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs

# --- c. AWS CLI v2 ---
# Arch-aware (uname -m), same idiom as modules/autoscaling/user-data.sh — this
# box is amd64-only (see main.tf's data.aws_ami.ubuntu comment) but keeping
# the same proven install line avoids inventing a second convention.
echo "--- Installing AWS CLI v2 ---"
curl -sL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o "/tmp/awscliv2.zip"
cd /tmp && unzip -q awscliv2.zip && ./aws/install && cd /
rm -rf /tmp/awscliv2.zip /tmp/aws

# --- d. Resolve the MSAB target ---
echo "--- Resolving MSAB target ---"
if [ -n "${msab_target_host}" ]; then
  MSAB_HOST="${msab_target_host}"
  echo "Using explicit msab_target_host: $MSAB_HOST"
else
  echo "Discovering MSAB target: Project=${project_name} Environment=${environment} Name=*-asg-instance, running (mirrors docs/runbooks/msab-loadgen-campaign.md step 0)"
  MSAB_HOST=$(aws ec2 describe-instances \
    --region "${region}" \
    --filters "Name=tag:Project,Values=${project_name}" \
               "Name=tag:Environment,Values=${environment}" \
               "Name=tag:Name,Values=*-asg-instance" \
               "Name=instance-state-name,Values=running" \
    --query 'Reservations[].Instances[].PublicIpAddress | [0]' \
    --output text 2>/dev/null || echo "")
  if [ -z "$MSAB_HOST" ] || [ "$MSAB_HOST" = "None" ]; then
    echo "FATAL: no running MSAB instance found for Project=${project_name} Environment=${environment} (Name=*-asg-instance) in ${region}."
    echo "       Cannot configure the Prometheus scrape target. Check the tags on the target ASG instance, or set msab_target_host explicitly."
    exit 1
  fi
  echo "Discovered MSAB target: $MSAB_HOST"
fi

# 🔴 The PRIVATE ip, for the Prometheus scrape ONLY. Not interchangeable with
# MSAB_HOST above, which stays PUBLIC because that is the address the harness
# must connect to (src/guard.mjs matches LOAD_HARNESS_ALLOW_TARGET against the
# config's hostname, and the staging DNS name is deny-listed).
#
# Why the scrape cannot use the public ip: the node_exporter port (9100) is
# opened on the MSAB security group with a SECURITY-GROUP source, not a CIDR.
# Traffic sent to an instance's public ip from inside the same VPC hairpins out
# through the internet gateway and arrives internet-sourced, so the
# security-group source reference can never match and the scrape times out.
# modules/networking/main.tf already documents this exact trap for the cascade
# relay ports. Proven here 2026-08-12: private 10.120.x:9100 -> HTTP 200 in
# 10ms, public 13.x:9100 -> timeout after 6s, with the SG rule correctly in
# place the whole time.
MSAB_PRIVATE=$(aws ec2 describe-instances \
  --region "${region}" \
  --filters "Name=tag:Project,Values=${project_name}" \
             "Name=tag:Environment,Values=${environment}" \
             "Name=tag:Name,Values=*-asg-instance" \
             "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].PrivateIpAddress | [0]' \
  --output text 2>/dev/null || echo "")
if [ -z "$MSAB_PRIVATE" ] || [ "$MSAB_PRIVATE" = "None" ]; then
  echo "FATAL: resolved MSAB public ip ($MSAB_HOST) but not its private ip."
  echo "       The Prometheus scrape requires the private address (see comment above)."
  exit 1
fi
echo "MSAB scrape address (private): $MSAB_PRIVATE"

# --- Prometheus system user + dirs, created NOW (not in step f below) ---
# The internal-key file written next needs an owner; the Prometheus BINARY
# install happens further down, after the SSM fetch. Same user, just an
# earlier creation point than the lettered checklist implies.
echo "--- Creating prometheus system user ---"
if ! id prometheus >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin prometheus
fi
mkdir -p /etc/prometheus /var/lib/prometheus
chown -R prometheus:prometheus /etc/prometheus /var/lib/prometheus

# --- e. Fetch the internal auth key from SSM ---
# ⛔ This value must never be printed anywhere below — it is the same secret
# (LARAVEL_INTERNAL_KEY) modules/autoscaling/user-data.sh's fetch_ssm() reads
# at MSAB's own boot. Command substitution already strips the trailing
# newline `--output text` appends; tr also strips a stray CR (same CRLF-paste
# class of bug fetch_ssm() guards against).
echo "--- Fetching internal key from SSM (${internal_key_ssm_path}) ---"
INTERNAL_KEY_VALUE=$(aws ssm get-parameter \
  --name "${internal_key_ssm_path}" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text \
  --region "${region}" | tr -d '\r')
if [ -z "$INTERNAL_KEY_VALUE" ]; then
  echo "FATAL: internal key at ${internal_key_ssm_path} is empty or the SSM read failed."
  echo "       The msab Prometheus scrape job will 401 without it (docs/runbooks/msab-loadgen-campaign.md step 3, row 2)."
  exit 1
fi
printf '%s' "$INTERNAL_KEY_VALUE" > /etc/prometheus/internal-key
chmod 0600 /etc/prometheus/internal-key
chown prometheus:prometheus /etc/prometheus/internal-key
unset INTERNAL_KEY_VALUE
echo "Internal key written to /etc/prometheus/internal-key (0600, prometheus:prometheus) — value not logged"

# --- f. Install Prometheus ${prometheus_version} ---
echo "--- Installing Prometheus ${prometheus_version} ---"
PROM_VERSION="${prometheus_version}"
PROM_TARBALL="prometheus-$PROM_VERSION.linux-amd64.tar.gz"
PROM_DIR="prometheus-$PROM_VERSION.linux-amd64"
curl -sL "https://github.com/prometheus/prometheus/releases/download/v$PROM_VERSION/$PROM_TARBALL" -o "/tmp/$PROM_TARBALL"
tar xzf "/tmp/$PROM_TARBALL" -C /tmp
install -m 0755 -o root -g root "/tmp/$PROM_DIR/prometheus" /usr/local/bin/prometheus
install -m 0755 -o root -g root "/tmp/$PROM_DIR/promtool" /usr/local/bin/promtool
rm -rf "/tmp/$PROM_TARBALL" "/tmp/$PROM_DIR"
echo "Prometheus $PROM_VERSION installed to /usr/local/bin"

cat > /etc/systemd/system/prometheus.service << 'PROMSVCEOF'
[Unit]
Description=Prometheus (loadgen box, aws-production/08)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=prometheus
Group=prometheus
ExecStart=/usr/local/bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/var/lib/prometheus \
  --web.listen-address=127.0.0.1:9090
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
PROMSVCEOF

# --- g. Prometheus scrape config ---
# __MSAB_SCRAPE__ is a boot-time placeholder, not a Terraform variable — the
# real value is only known once step d's discovery runs, so it is substituted
# with sed AFTER this file is written (task instruction: "substitute the
# resolved host at boot", never at Terraform render time).
# honor_labels: true on BOTH jobs is REQUIRED, not a style choice — MSAB
# publishes its own region/instance labels on the six audio series, and
# without honor_labels the scraper renames them exported_* and every SLO
# query in the harness reads the wrong labels (scripts/load-harness/README.md).
echo "--- Writing Prometheus config ---"
#
# 🔴 The `region` TARGET LABEL is mandatory. Every gate, guard and readout in
# scripts/load-harness/src/queries.mjs filters on region="<value>" — including
# V1 (`up{region=...}`), R4 (`nodejs_eventloop_lag_p99_seconds{region=...}`) and
# R5 (`process_cpu_seconds_total{region=...}`). Those three series are
# Prometheus-synthesized or prom-client defaults and carry NO region label of
# their own, so without a target label they match nothing, V1 fails, and the
# step is VOID before a single threshold is read.
# Proven here 2026-08-12: with honor_labels set but no target label,
# `/api/v1/label/region/values` returned [] and `up{region="ap-south-1"}` was
# empty — the same VOID-at-step-0 failure the harness-side region fix removed,
# arriving from the scrape side instead.
#
# The value MUST equal what MSAB itself publishes on the six audio series
# (config.AWS_REGION -> src/domains/media/quality/qualityPublisher.ts:36).
# It does, by construction: modules/autoscaling/user-data.sh sets
# AWS_REGION=${region} from the same Terraform variable interpolated here.
# honor_labels: true then keeps MSAB's own value on the series that publish one
# and applies this target label to everything else — so both agree either way.
cat > /etc/prometheus/prometheus.yml << PROMCFGEOF
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: msab
    honor_labels: true
    metrics_path: /metrics/prometheus
    http_headers:
      X-Internal-Key:
        files: [/etc/prometheus/internal-key]
    static_configs:
      - targets: ["__MSAB_SCRAPE__:${msab_app_port}"]
        labels:
          region: "${region}"

  - job_name: node
    honor_labels: true
    static_configs:
      - targets: ["__MSAB_SCRAPE__:9100"]
        labels:
          region: "${region}"
PROMCFGEOF

sed -i "s#__MSAB_SCRAPE__#$MSAB_PRIVATE#g" /etc/prometheus/prometheus.yml
chown prometheus:prometheus /etc/prometheus/prometheus.yml

echo "--- Starting Prometheus ---"
systemctl daemon-reload
systemctl enable prometheus
systemctl start prometheus
sleep 3
if ! systemctl is-active --quiet prometheus; then
  echo "FATAL: prometheus is not active after start."
  systemctl status prometheus --no-pager || true
  exit 1
fi
echo "Prometheus active — scraping msab:${msab_app_port} and node:9100 on $MSAB_PRIVATE (private path; local UI: 127.0.0.1:9090)"

# --- h. netem helper — NOT applied automatically (task instruction) ---
# Real loss/delay is a hard prerequisite for a gated harness run: a clean
# same-subnet path reads RTT~0, pre-flight V4 fails, and the RTP verdict
# comes back VOID instead of PASS/FAIL (scripts/load-harness/README.md;
# docs/runbooks/msab-loadgen-campaign.md step 7).
echo "--- Installing netem helper (not applied) ---"
cat > /usr/local/bin/loadgen-netem.sh << 'NETEMEOF'
#!/bin/bash
set -euo pipefail

IFACE="$(ip route show default | awk '{print $5}')"
if [ -z "$IFACE" ]; then
  echo "FATAL: could not detect the primary interface via 'ip route show default'."
  exit 1
fi

if [ "$${1:-}" = "clear" ]; then
  echo "Clearing netem qdisc on $IFACE"
  tc qdisc del dev "$IFACE" root netem
  exit 0
fi

echo "Applying netem on $IFACE: delay 40ms 10ms loss 0.5%"
tc qdisc add dev "$IFACE" root netem delay 40ms 10ms loss 0.5%
NETEMEOF
chmod +x /usr/local/bin/loadgen-netem.sh
echo "netem helper installed at /usr/local/bin/loadgen-netem.sh (run by hand: 'loadgen-netem.sh' to apply, 'loadgen-netem.sh clear' to remove)"

# --- i. Deliver the load-harness (optional) ---
echo "--- Load-harness delivery ---"
if [ -n "${harness_s3_uri}" ]; then
  echo "Fetching harness from ${harness_s3_uri}"
  aws s3 cp "${harness_s3_uri}" /opt/load-harness.tgz --region "${region}"
  # Matches docs/runbooks/msab-loadgen-campaign.md step 4 exactly: the tarball
  # already contains a load-harness/ prefix (packed via
  # `tar czf ... load-harness` from its parent dir), so extracting straight
  # into /opt (no --strip-components) yields /opt/load-harness/.
  tar xzf /opt/load-harness.tgz -C /opt
  chown -R ubuntu:ubuntu /opt/load-harness
  echo "Running npm install --omit=dev as non-root (ubuntu)..."
  su - ubuntu -c 'cd /opt/load-harness && npm install --omit=dev'
  echo "Harness installed at /opt/load-harness"
else
  echo "harness_s3_uri is empty — skipping harness delivery."
  echo "Deliver it by hand: docs/runbooks/msab-loadgen-campaign.md step 4."
fi

# --- j. Readiness marker — the operator's single file to check ---
cat > /opt/loadgen-READY << READYEOF
MSAB_HOST=$MSAB_HOST
MSAB_SCRAPE_PRIVATE=$MSAB_PRIVATE
READY_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
READYEOF

echo "=== Loadgen bootstrap complete — MSAB target: $MSAB_HOST ==="

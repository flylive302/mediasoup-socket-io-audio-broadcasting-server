#!/usr/bin/env bash
# Read or write one field of the MSAB runtime flag hash `gift:flags` on the durable
# Valkey, from INSIDE the running msab container via SSM Run Command.
# See docs/issues/gift-authority-tick-fanout/runbook-gift-flags.md.
#
#   scripts/aws/gift-flag.sh                       # read all flags
#   scripts/aws/gift-flag.sh GIFT_FLUSH_PARTITIONS 8   # HSET one flag, print before/after
#
# Env: AWS_REGION (default ap-south-1), MSAB_INSTANCE_ID (default: first running ASG instance).
set -euo pipefail

REGION="${AWS_REGION:-ap-south-1}"
FIELD="${1:-}"
VALUE="${2:-}"

INSTANCE="${MSAB_INSTANCE_ID:-$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=instance-state-name,Values=running" "Name=tag:Name,Values=flylive-audio-production-asg-instance" \
  --query "Reservations[0].Instances[0].InstanceId" --output text)}"

SCRIPT=$(cat <<'EOF'
const Redis = require("ioredis");
const e = process.env;
const r = new Redis({
  host: e.REDIS_HOST, port: Number(e.REDIS_PORT || 6379), db: Number(e.REDIS_DB || 0),
  password: e.REDIS_PASSWORD || undefined,
  tls: /^(1|true)$/i.test(e.REDIS_TLS || "") ? {} : undefined,
});
(async () => {
  const [field, value] = process.argv.slice(2);
  console.log("before", JSON.stringify(await r.hgetall("gift:flags")));
  if (field && value !== undefined) {
    await r.hset("gift:flags", field, value);
    console.log("after", JSON.stringify(await r.hgetall("gift:flags")));
  }
  r.disconnect();
})().catch((x) => { console.error(x); process.exit(1); });
EOF
)
B64=$(printf '%s' "$SCRIPT" | base64 -w0)

ARGS=""
if [[ -n "$FIELD" ]]; then ARGS=" $FIELD $VALUE"; fi

CMD_ID=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript \
  --parameters "commands=[\"echo $B64 | base64 -d > /tmp/flag.cjs\",\"docker cp /tmp/flag.cjs msab:/app/flag.cjs\",\"docker exec -w /app msab node /app/flag.cjs$ARGS\",\"docker exec -u root msab rm -f /app/flag.cjs\"]" \
  --query Command.CommandId --output text)

echo "instance=$INSTANCE command=$CMD_ID"
for _ in $(seq 1 20); do
  sleep 3
  STATUS=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  case "$STATUS" in Pending|InProgress|Delayed) continue ;; esac
  break
done
aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE" \
  --query '[Status,StandardOutputContent,StandardErrorContent]' --output text

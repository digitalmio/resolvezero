#!/usr/bin/env bash
# Multi-region deploy (readme §7): pushes the same image to every region in
# FLY_REGIONS; each machine joins the anycast IPv4 for that app automatically.
#
# Usage:
#   FLY_REGIONS="lhr fra iad sjc" ./scripts/deploy.sh
#   FLY_REGIONS="lhr" FLY_SCALE=2 ./scripts/deploy.sh   # 2 machines per region
set -euo pipefail

FLY_REGIONS="${FLY_REGIONS:-fra}"
FLY_SCALE="${FLY_SCALE:-1}"
APP="$(sed -n 's/^app = "\([^"]*\)"/\1/p' fly.toml | head -1)"

echo "==> Deploying $APP to [$FLY_REGIONS], $FLY_SCALE machine(s) per region"
fly deploy --strategy immediate

for region in $FLY_REGIONS; do
  # Route is per region; scale ensures N warm machines (min_machines_running=1 in fly.toml)
  fly scale count "$FLY_SCALE" --region "$region" --app "$APP" --yes
  echo "==> $region: $FLY_SCALE machine(s) live"
done

fly status --app "$APP"
echo "Done. Regions: $FLY_REGIONS, scale $FLY_SCALE each."

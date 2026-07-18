#!/usr/bin/env bash
# pg_dump 备份（宿主定时任务用；JSON 快照见 backups volume，每日自动）
# 用法：./scripts/backup-pg.sh [输出目录=./pg-backups]
set -euo pipefail
OUT_DIR="${1:-./pg-backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
docker compose exec -T postgres pg_dump -U paperwiki paperwiki | gzip > "$OUT_DIR/paperwiki-$STAMP.sql.gz"
echo "备份完成: $OUT_DIR/paperwiki-$STAMP.sql.gz"
# 保留最近 14 份
ls -1t "$OUT_DIR"/paperwiki-*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm --

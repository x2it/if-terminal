#!/bin/sh
# 代码快照 —— 改代码之前跑一次, 改崩了用 tools/restore.sh 一键回滚。
#
#   用法: sh tools/snapshot.sh [说明]
#   例  : sh tools/snapshot.sh "加配置锁之前"
#   列出: sh tools/restore.sh
#
# 只依赖 sh + tar ( gzip ), 与项目"零依赖"原则一致。
# 快照落在 .snapshots/ (已在 .gitignore 中), 默认保留最近 20 份。
# 说明文字单独存在同名 .note 里, 不拼进文件名 —— 这样中文说明也不会被转义成乱码。

set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SNAPDIR="$ROOT/.snapshots"
KEEP=20
NOTE=${1:-manual}

mkdir -p "$SNAPDIR"
# 文件名必须唯一: 同一秒内连续打两份快照会互相覆盖(回滚时会把"当前"当"目标"写回去)。
# 统一带两位序号后缀, 这样文件名长度一致、字典序严格等于时间序,
# restore.sh 才能靠 sort -r 正确排出"最新在前"。
STAMP=$(date +%Y%m%d-%H%M%S)
N=0
while [ -e "$SNAPDIR/$STAMP-$(printf '%02d' "$N").tar.gz" ]; do N=$((N + 1)); done
ID="$STAMP-$(printf '%02d' "$N")"
FILE="$SNAPDIR/$ID.tar.gz"

printf '%s\n' "$NOTE" > "$SNAPDIR/$ID.note"

# 排除快照目录自身与常见无关目录, 其余全部打包
tar -czf "$FILE" \
  -C "$ROOT" \
  --exclude='./.snapshots' \
  --exclude='./node_modules' \
  --exclude='./.git' \
  --exclude='./core.*' \
  . 2>/dev/null

printf '快照已保存: %s  %s  ( %s )\n' "$ID" "$NOTE" "$(du -h "$FILE" | cut -f1)"

# 只保留最近 KEEP 份 (连 .note 一起清)
ls -1 "$SNAPDIR"/*.tar.gz 2>/dev/null | sort | head -n -"$KEEP" | while read -r old; do
  rm -f "$old" "${old%.tar.gz}.note"
  printf '已清理旧快照: %s\n' "$(basename "$old")"
done

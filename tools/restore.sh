#!/bin/sh
# 从代码快照回滚 —— 改错了、被别人改乱了, 一条命令回到之前的版本。
#
#   列出快照: sh tools/restore.sh
#   回滚    : sh tools/restore.sh 3          (3 = 列表里的编号, 1 是最新)
#   回滚最新: sh tools/restore.sh last
#
# 回滚前会自动再打一份"回滚前"快照, 所以回滚本身也能反悔。
# 只依赖 sh + tar ( gzip )。

set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SNAPDIR="$ROOT/.snapshots"

if [ ! -d "$SNAPDIR" ] || [ -z "$(ls -A "$SNAPDIR" 2>/dev/null)" ]; then
  printf '还没有任何快照。先跑: sh tools/snapshot.sh "改代码之前"\n'
  exit 1
fi

# 最新的排在最前, 编号 1 = 最新。
# 用文件名排序而非 mtime: 同一秒内的两份快照 mtime 相同, 顺序不可靠;
# 而文件名是 YYYYMMDD-HHMMSS[-N], 字典序天然等于时间序。
LIST=$(ls -1 "$SNAPDIR"/*.tar.gz 2>/dev/null | sort -r)
COUNT=$(printf '%s\n' "$LIST" | wc -l | tr -d ' ')

if [ $# -eq 0 ]; then
  printf '共 %s 份代码快照 ( .snapshots/ ):\n\n' "$COUNT"
  i=1
  printf '%s\n' "$LIST" | while read -r f; do
    base=$(basename "$f" .tar.gz)
    # 20261006-012436[-1] -> 2026-10-06 01:24:36
    when=$(printf '%s' "$base" | sed -E 's/^([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})([0-9]{2})(-[0-9]+)?$/\1-\2-\3 \4:\5:\6/')
    note=$(cat "$SNAPDIR/$base.note" 2>/dev/null || printf '(无说明)')
    printf '  [%2s] %s  %6s  %s\n' "$i" "$when" "$(du -h "$f" | cut -f1)" "$note"
    i=$((i + 1))
  done
  printf '\n回滚: sh tools/restore.sh <编号>   (1 = 最新)\n'
  exit 0
fi

ARG=$1
if [ "$ARG" = "last" ] || [ "$ARG" = "1" ]; then
  TARGET=$(printf '%s\n' "$LIST" | sed -n '1p')
else
  TARGET=$(printf '%s\n' "$LIST" | sed -n "${ARG}p")
fi

if [ -z "$TARGET" ] || [ ! -f "$TARGET" ]; then
  printf '编号不存在: %s (共 %s 份)\n' "$ARG" "$COUNT"
  exit 1
fi

base=$(basename "$TARGET" .tar.gz)
note=$(cat "$SNAPDIR/$base.note" 2>/dev/null || printf '(无说明)')
printf '即将回滚到: %s  %s\n' "$base" "$note"
printf '当前代码会先自动存一份快照 (万一回滚错了还能回去)。\n'
printf '继续? [y/N] '
read -r ans
[ "$ans" = "y" ] || [ "$ans" = "Y" ] || { printf '已取消\n'; exit 0; }

sh "$ROOT/tools/snapshot.sh" "回滚前-$base"

tar -xzf "$TARGET" -C "$ROOT"
printf '\n已回滚到: %s  %s\n' "$base" "$note"
printf '若部署在远端, 记得重启服务 (Docker: docker compose restart)。\n'

#!/usr/bin/env bash
# End every running Celestea Studio desktop instance, then clear the tray entries
# they may have left behind.
#
# WHY THIS SCRIPT EXISTS instead of a plain `pkill`: an instance can be in three
# states, and only one of them is reachable by name:
#
#   1. responsive  — it answers on its tray menu. `--graceful` (default) asks it to
#                    quit through its own exit path (drains the server, closes
#                    session logs, releases the instance lock). Best case.
#   2. hung        — its D-Bus name still exists but its menu does not answer
#                    (measured: GetLayout times out). Nothing in the app can end it;
#                    only a signal can, so this script falls back to `pkill`.
#   3. gone        — the process already exited but the panel still shows its icon.
#                    No process to kill: the icon disappears only when the
#                    AppIndicator extension re-reads the registrations, which is
#                    the last step here.
#
# Run it in YOUR terminal (not through an agent): process control needs the
# session's PID namespace, and an agent sandbox may have its own.
#
#   bash desktop/scripts/quit-instances.sh              # graceful, then verify
#   bash desktop/scripts/quit-instances.sh --force      # also pkill -9 leftovers
#   bash desktop/scripts/quit-instances.sh --no-refresh # do not touch the panel
set -uo pipefail

FORCE=0
REFRESH=1
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --no-refresh) REFRESH=0 ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }

# --- 1. graceful quit through each tray menu ----------------------------------
say "① 通过托盘「退出」项请求关闭（走应用自己的退出路径）"
asked=0
while IFS= read -r entry; do
  bus="${entry%%@*}"
  path="${entry#*@}"
  [ -z "$bus" ] && continue
  layout=$(gdbus call --session --timeout 3 --dest "$bus" --object-path "$path/Menu" \
             --method com.canonical.dbusmenu.GetLayout 0 3 "[]" 2>/dev/null)
  # Our app is identified by its own menu copy, not by the object path: several
  # apps use libayatana-appindicator and therefore the same path shape.
  case "$layout" in
    *"退出 Celestea Studio"*|*"Quit Celestea Studio"*) ;;
    *) continue ;;
  esac
  quit_id=$(printf '%s\n' "$layout" | grep -oE "\(([0-9]+), \{'label': <'(退出|Quit)" | grep -oE "[0-9]+" | head -1)
  [ -z "$quit_id" ] && continue
  if gdbus call --session --timeout 5 --dest "$bus" --object-path "$path/Menu" \
       --method com.canonical.dbusmenu.Event "$quit_id" clicked "<''>" 0 >/dev/null 2>&1; then
    say "   $bus：已请求退出"
    asked=$((asked + 1))
  else
    say "   $bus：菜单无响应（进程卡住）→ 需要信号"
  fi
done < <(gdbus call --session --timeout 5 --dest org.kde.StatusNotifierWatcher \
           --object-path /StatusNotifierWatcher --method org.freedesktop.DBus.Properties.Get \
           org.kde.StatusNotifierWatcher RegisteredStatusNotifierItems 2>/dev/null \
         | grep -oE ":1\.[0-9]+@[^']*")
[ "$asked" -eq 0 ] && say "   （没有可响应的实例）"

sleep 2

# --- 2. list what is still running -------------------------------------------
# The dev server (`pnpm start` / tsx) has "Celestea-Harness-Studio" in its command
# line — with hyphens — so it never matches the pattern used here.
say
say "② 仍然在运行的桌面进程"
leftover=$(pgrep -af 'celesteastudio' 2>/dev/null | grep -viE 'quit-instances|grep' || true)
if [ -z "$leftover" ]; then
  say "   没有"
else
  printf '   %s\n' "$leftover"
fi

# --- 3. signal the leftovers --------------------------------------------------
if [ -n "$leftover" ]; then
  say
  say "③ 信号它们（先 TERM；卡住的进程通常只有 KILL 有效）"
  pkill -i -f 'celesteastudio' 2>/dev/null && say "   sent TERM" || say "   TERM 没有命中"
  sleep 2
  if [ "$FORCE" -eq 1 ]; then
    pkill -9 -i -f 'celesteastudio' 2>/dev/null && say "   sent KILL" || say "   KILL 没有命中"
    sleep 1
  else
    still=$(pgrep -af 'celesteastudio' 2>/dev/null | grep -viE 'quit-instances|grep' || true)
    [ -n "$still" ] && say "   仍有进程存活；需要更硬的手段就加 --force（pkill -9）"
  fi
fi

# --- 4. wake the panel so stale icons go away ---------------------------------
if [ "$REFRESH" -eq 1 ]; then
  say
  say "④ 刷新面板（进程已退出但图标还在时，只有扩展重载能让它消失）"
  ext=$(gnome-extensions list 2>/dev/null | grep -iE 'appindicator' | head -1)
  if [ -n "$ext" ]; then
    gnome-extensions disable "$ext" >/dev/null 2>&1 && sleep 1 && gnome-extensions enable "$ext" >/dev/null 2>&1 \
      && say "   已重载 $ext" || say "   重载 $ext 失败（可手动执行 gnome-extensions disable/enable $ext）"
  else
    say "   没找到 AppIndicator 扩展（非 GNOME 桌面？KDE 下右键托盘区域 → 系统托盘设置即可）"
  fi
fi

say
say "完成。若面板上仍有点不动的图标且确认没有活进程，重启面板/桌面会话即可。"

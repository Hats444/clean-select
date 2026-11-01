#!/data/data/com.termux/files/usr/bin/sh
# Supervisor do daemon: se o processo morrer por QUALQUER motivo, recoloca
# de pé com backoff. Rode este script em vez de `node src/main.ts --daemon`.
cd "$(dirname "$0")" || exit 1
termux-wake-lock 2>/dev/null
fail=0
while true; do
  echo "[watchdog] subindo daemon $(date '+%H:%M:%S')"
  node src/main.ts --daemon >> "$HOME/.clean_select/daemon.out" 2>&1
  rc=$?
  fail=$((fail + 1))
  wait_s=$((fail * 30))
  [ "$wait_s" -gt 300 ] && wait_s=300
  echo "[watchdog] daemon saiu (rc=$rc) — reiniciando em ${wait_s}s (queda #$fail)"
  sleep "$wait_s"
done

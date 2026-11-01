#!/data/data/com.termux/files/usr/bin/sh
# Verificação agendada (termux-job-scheduler): se o heartbeat do daemon
# estiver parado há mais de 15 min ou o processo não existir, ressuscita.
cd "$(dirname "$0")" || exit 1
HB="$HOME/.clean_select/daemon.json"
alive=0
if [ -f "$HB" ]; then
  pid=$(grep -o '"pid": [0-9]*' "$HB" | grep -o '[0-9]*')
  if [ -n "$pid" ] && [ -d "/proc/$pid" ]; then alive=1; fi
fi
if [ "$alive" -eq 0 ]; then
  echo "[check-alive] daemon morto — ressuscitando via watchdog"
  termux-wake-lock 2>/dev/null
  nohup sh ./watchdog.sh >> "$HOME/.clean_select/watchdog.out" 2>&1 &
else
  echo "[check-alive] daemon vivo (pid $pid)"
fi

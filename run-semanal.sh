#!/data/data/com.termux/files/usr/bin/sh
# Limpeza semanal (domingo): diário + poda de node_modules + rotação de backups.
cd "$(dirname "$0")" || exit 1
termux-wake-lock 2>/dev/null
node src/main.ts --perfil semanal --apply --auto > /tmp/clean_select_semanal.txt 2>&1
termux-notification --title "Clean Select (semanal)" \
  --content "$(tail -n 3 /tmp/clean_select_semanal.txt | tr '\n' ' ')" 2>/dev/null
termux-wake-unlock 2>/dev/null

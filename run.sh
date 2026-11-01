#!/data/data/com.termux/files/usr/bin/sh
# Limpeza diária automatizada (Termux). Usada por --instalar-agenda.
cd "$(dirname "$0")" || exit 1
termux-wake-lock 2>/dev/null
node src/main.ts --perfil diario --apply --auto > /tmp/clean_select_last.txt 2>&1
termux-notification --title "Clean Select" \
  --content "$(tail -n 3 /tmp/clean_select_last.txt | tr '\n' ' ')" 2>/dev/null
termux-wake-unlock 2>/dev/null

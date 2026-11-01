import { log } from "./trash.ts";

/**
 * Controle remoto opcional via Telegram (só fetch nativo, desativado por padrão).
 * Ativa com --remote + env CLEAN_SELECT_TG_TOKEN e CLEAN_SELECT_TG_CHAT.
 * Aceita apenas o chat ID autorizado. /limpar sempre roda dry-run e exige /confirmar.
 */
export async function remoteLoop(handlers: {
  status: () => Promise<string>;
  dryRun: () => Promise<string>;
  relatorio: () => Promise<string>;
  stats: () => Promise<string>;
}): Promise<void> {
  const token = process.env.CLEAN_SELECT_TG_TOKEN;
  const chatId = process.env.CLEAN_SELECT_TG_CHAT;
  if (!token || !chatId) {
    console.error("remote requer CLEAN_SELECT_TG_TOKEN e CLEAN_SELECT_TG_CHAT no ambiente.");
    return;
  }
  const api = `https://api.telegram.org/bot${token}`;
  const send = async (text: string) => {
    await fetch(`${api}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
    }).catch(() => undefined);
  };
  let offset = 0;
  let pendingClean = false;
  await log("remote: loop iniciado");
  await send("clean-select remoto ativo. /status /limpar /relatorio /stats");
  for (;;) {
    try {
      const r = await fetch(`${api}/getUpdates?offset=${offset}&timeout=30`);
      const j = (await r.json()) as {
        ok: boolean;
        result: { update_id: number; message?: { chat: { id: number }; text?: string } }[];
      };
      for (const u of j.result ?? []) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg?.text || String(msg.chat.id) !== chatId) continue; // só o chat autorizado
        const cmd = msg.text.split(" ")[0].toLowerCase();
        if (cmd === "/status") await send(await handlers.status());
        else if (cmd === "/stats") await send(await handlers.stats());
        else if (cmd === "/relatorio") await send(await handlers.relatorio());
        else if (cmd === "/limpar") {
          pendingClean = true;
          await send("dry-run:\n" + (await handlers.dryRun()) + "\n\nEnvie /confirmar para aplicar.");
        } else if (cmd === "/confirmar" && pendingClean) {
          pendingClean = false;
          await send("confirmação remota registrada — execute --apply localmente por segurança.");
        } else if (cmd === "/restaurar") {
          await send("use --restore <id> localmente; ids em ~/.clean_select/trash/manifest.json");
        }
      }
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

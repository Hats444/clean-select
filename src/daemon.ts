import { statfs, writeFile, mkdir } from "node:fs/promises";
import type { Finding, Rules } from "./types.ts";
import { CS_HOME, mb, nowIso } from "./util.ts";
import { log, purgeOldTrash } from "./trash.ts";
import { applyFindings, runningCwds } from "./cleaner.ts";
import { findDuplicates } from "./dedupe.ts";
import { recordRun } from "./stats.ts";

export interface DaemonHooks {
  /** roda a varredura completa e devolve os dados necessários */
  scan: (emergency: boolean) => Promise<{
    findings: Finding[];
    dedupeCandidates: { path: string; rel: string; size: number; mtimeMs: number }[];
    projectDirs: Set<string>;
    totalFiles: number;
  }>;
}

const HEARTBEAT = `${CS_HOME}/daemon.json`;

/**
 * Modo automático: dorme, acorda a cada `checkMin` minutos e decide sozinho.
 * - espaço livre < 10% -> modo emergência (limpa o máximo seguro)
 * - senão, a cada `runHours` horas -> limpeza diária (só regras [auto] + dedupe --auto)
 * Nunca pergunta nada: o que exige confirmação fica para a execução manual.
 */
export async function daemonLoop(
  root: string,
  rules: Rules,
  hooks: DaemonHooks,
  opts: { checkMin?: number; runHours?: number } = {},
): Promise<void> {
  const checkMs = (opts.checkMin ?? 30) * 60_000;
  const runMs = (opts.runHours ?? 24) * 3_600_000;
  let lastRun = 0;

  const beat = async (extra: Record<string, unknown> = {}) => {
    try {
      await mkdir(CS_HOME, { recursive: true });
      const s = await statfs(root);
      await writeFile(HEARTBEAT, JSON.stringify({
        pid: process.pid, at: nowIso(), root,
        freeMb: Math.round(s.bavail * s.bsize / 1048576),
        lastRun: lastRun ? new Date(lastRun).toISOString() : null,
        ...extra,
      }, null, 1));
    } catch { /* beat nunca derruba o daemon */ }
  };

  await log(`daemon up: root=${root} check=${opts.checkMin ?? 30}min run=${opts.runHours ?? 24}h`);
  console.log(`daemon ativo — verificação a cada ${opts.checkMin ?? 30} min, limpeza a cada ${opts.runHours ?? 24} h`);
  console.log("parar: Ctrl+C ou delete ~/.clean_select/lock");

  for (;;) {
    try {
      let freePct = 100;
      try {
        const s = await statfs(root);
        freePct = (s.bavail / s.blocks) * 100;
      } catch { /* statfs indisponível */ }

      const emergency = freePct < 10;
      const due = Date.now() - lastRun > runMs;

      if (emergency || due) {
        const mode = emergency ? "emergencia" : "diario";
        console.log(`${nowIso()} [${mode}] espaço livre ${freePct.toFixed(1)}% — varrendo…`);
        const t0 = Date.now();
        const { findings, dedupeCandidates, projectDirs } = await hooks.scan(emergency);

        // só o que é [auto] entra no piloto automático (K nunca)
        const auto = findings.filter((f) => f.level === "auto" && f.letter !== "K");
        const cwds = await runningCwds();
        const r = await applyFindings(auto, { cwds, root });

        // dedupe restrito às zonas seguras (--auto)
        const { groups } = await findDuplicates(dedupeCandidates, {
          priorities: rules.dedupePriority,
          autoZones: rules.dedupeAutoZones,
          auto: true,
          projectDirs,
        });
        const dupFindings: Finding[] = [];
        const meta = new Map<string, { hash: string; keptOriginal: string }>();
        for (const g of groups) {
          for (const f of g.remove) {
            dupFindings.push({
              path: f.path, rel: f.rel, size: f.size, mtimeMs: f.mtimeMs,
              ruleId: "M", letter: "M", level: "auto",
            });
            meta.set(f.path, { hash: g.hash, keptOriginal: g.keep!.path });
          }
        }
        const rd = await applyFindings(dupFindings, { meta: (f) => meta.get(f.path) ?? {}, cwds, root });

        const freed = r.freed + rd.freed;
        await purgeOldTrash();
        await recordRun({
          date: new Date().toISOString(), profile: `daemon:${mode}`,
          freedByLetter: {}, freedTotal: freed, durationMs: Date.now() - t0,
        });
        lastRun = Date.now();
        console.log(`${nowIso()} [${mode}] feito: ${r.removed + rd.removed} itens, ${mb(freed)} MB liberados`);
        await beat({ mode, freedMb: Math.round(freed / 1048576) });
      } else {
        await beat({ idle: true, freePct: Number(freePct.toFixed(1)) });
      }
    } catch (e) {
      await log(`daemon erro: ${String(e)}`);
      console.error("ciclo falhou (seguindo):", String(e));
    }
    await new Promise((r) => setTimeout(r, checkMs));
  }
}

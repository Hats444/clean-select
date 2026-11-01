import { statfs, writeFile, mkdir } from "node:fs/promises";
import type { Finding, Rules } from "./types.ts";
import { CS_HOME, mb, nowIso } from "./util.ts";
import { log, purgeOldTrash } from "./trash.ts";
import { applyFindings, runningCwds } from "./cleaner.ts";
import { findDuplicates } from "./dedupe.ts";
import { recordRun } from "./stats.ts";

export type DaemonMode = "diario" | "reforco" | "emergencia";

export interface DaemonHooks {
  /** roda a varredura completa e devolve os dados necessários */
  scan: (mode: DaemonMode) => Promise<{
    findings: Finding[];
    dedupeCandidates: { path: string; rel: string; size: number; mtimeMs: number }[];
    projectDirs: Set<string>;
    totalFiles: number;
  }>;
}

/** quão fundo o piloto automático vai conforme o espaço livre */
export function modeFor(freePct: number): DaemonMode {
  if (freePct < 10) return "emergencia";
  if (freePct < 25) return "reforco";
  return "diario";
}

/** o que cada modo pode aplicar sem perguntar */
export function allowedInMode(f: Finding, mode: DaemonMode): boolean {
  if (f.letter === "K" || f.level === "relatorio") return false;
  if (mode === "diario") return f.level === "auto";
  // reforco/emergencia: auto + confirmar seguro (tudo já passa pela lixeira)
  return f.level === "auto" || f.level === "confirmar";
}

const HEARTBEAT = `${CS_HOME}/daemon.json`;

/**
 * Piloto automático escalonado — quanto menos espaço, mais fundo ele vai:
 *   >= 25% livre: diario    — só regras [auto] + dedupe --auto
 *   10–25%:       reforco   — + categorias [confirmar] seguras (backups velhos,
 *                            APKs, pastas vazias, node_modules, dist) e idade menor
 *   < 10%:        emergencia — tudo acima + regras [AGR] (mídia antiga, F3, G.shots)
 * A varredura completa roda a cada `runHours` h; abaixo de 25% roda em todo ciclo.
 * Nada é apagado de verdade: tudo passa pela lixeira de 7 dias.
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

      const mode = modeFor(freePct);
      const due = Date.now() - lastRun > runMs;
      // abaixo de 25% a gente não espera a janela diária: varre em todo ciclo
      const shouldRun = mode !== "diario" || due;

      if (shouldRun) {
        console.log(`${nowIso()} [${mode}] espaço livre ${freePct.toFixed(1)}% — varrendo…`);
        const t0 = Date.now();
        const { findings, dedupeCandidates, projectDirs } = await hooks.scan(mode);

        const auto = findings.filter((f) => allowedInMode(f, mode));
        const cwds = await runningCwds();
        const r = await applyFindings(auto, { cwds, root });

        // dedupe: zonas seguras no diário/reforço; todas as zonas na emergência
        const { groups } = await findDuplicates(dedupeCandidates, {
          priorities: rules.dedupePriority,
          autoZones: rules.dedupeAutoZones,
          auto: mode !== "emergencia",
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
        // mede o efeito real no disco em vez de só somar o que mandou p/ lixeira
        let realDelta = "";
        try {
          const s2 = await statfs(root);
          const nowPct = (s2.bavail / s2.blocks) * 100;
          realDelta = ` | livre agora ${nowPct.toFixed(1)}%`;
        } catch { /* ok */ }
        console.log(`${nowIso()} [${mode}] feito: ${r.removed + rd.removed} itens, ${mb(freed)} MB p/ lixeira${realDelta}`);
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

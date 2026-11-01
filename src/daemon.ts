import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { Finding, Rules, ScanStats } from "./types.ts";
import { CS_HOME, diskInfo, mb, nowIso, sizeFmt } from "./util.ts";
import { cfg, reloadCfg } from "./config.ts";
import { acquireLock } from "./cleaner.ts";
import { emptyTrash, log, purgeOldTrash, trashSize } from "./trash.ts";
import { applyFindings, runningCwds } from "./cleaner.ts";
import { findDuplicates } from "./dedupe.ts";
import { recordRun } from "./stats.ts";
import { asciiBar } from "./report.ts";

export type DaemonMode = "diario" | "reforco" | "emergencia";

export interface DaemonHooks {
  /** roda a varredura completa e devolve os dados necessários */
  scan: (mode: DaemonMode) => Promise<{
    findings: Finding[];
    dedupeCandidates: { path: string; rel: string; size: number; mtimeMs: number }[];
    projectDirs: Set<string>;
    stats: ScanStats;
    scanMs: number;
  }>;
}

/** quão fundo o piloto automático vai conforme o espaço livre (thresholds no .env) */
export function modeFor(freePct: number): DaemonMode {
  if (freePct < cfg.freeEmergencyPct) return "emergencia";
  if (freePct < cfg.freeTargetPct) return "reforco";
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
const NAMES: Record<string, string> = {
  A: "node/projetos", B: "backups", C: "espelhos", D: "temp de bots",
  E: "logs", F: "whatsapp", G: "mídia/thumbs", H: "sobras de apps",
  I: "ext. descartáveis", J: "downloads/apk", K: "dados teste",
  L: "relatório", M: "duplicados",
};

function grouped(findings: Finding[]): Map<string, Finding[]> {
  const m = new Map<string, Finding[]>();
  for (const f of findings) {
    const a = m.get(f.letter) ?? [];
    a.push(f);
    m.set(f.letter, a);
  }
  return m;
}

/**
 * Piloto automático escalonado — quanto menos espaço, mais fundo ele vai:
 *   >= 25% livre: diario    — só regras [auto] + dedupe --auto
 *   10–25%:       reforco   — + categorias [confirmar] seguras e idade menor
 *   < 10%:        emergencia — tudo acima + regras [AGR]
 * Abaixo de 25% varre em todo ciclo. Tudo passa pela lixeira de 7 dias.
 * Painel em tempo real: cada ciclo imprime métricas completas e um countdown
 * ao vivo marca a próxima verificação. Estado completo no daemon.json.
 */
export async function daemonLoop(
  root: string,
  rules: Rules,
  hooks: DaemonHooks,
  opts: { checkMin?: number; runHours?: number } = {},
): Promise<void> {
  // guarda contra daemon duplo: se já tem um vivo, aborta
  try {
    const j = JSON.parse(await readFile(HEARTBEAT, "utf8"));
    if (j.pid && j.pid !== process.pid) {
      try { process.kill(j.pid, 0); console.error(`daemon já rodando (pid ${j.pid}). Use --status.`); process.exit(4); }
      catch { /* pid morto, segue */ }
    }
  } catch { /* sem heartbeat */ }

  // lidos por ciclo (o .env pode mudar a qualquer momento)
  const checkMs = () => (opts.checkMin ?? cfg.checkMin) * 60_000;
  const runMs = () => (opts.runHours ?? cfg.runHours) * 3_600_000;
  let lastRun = 0;
  let lastMode: DaemonMode = "diario";
  let lastFreed = 0;
  let cycles = 0;

  const free = async () => {
    const d = await diskInfo(root);
    return {
      mb: d.free / 1048576,
      pct: d.total > 0 ? (d.free / d.total) * 100 : 100,
      total: d.total / 1048576,
      source: d.source,
    };
  };

  const beat = async (extra: Record<string, unknown> = {}) => {
    try {
      await mkdir(CS_HOME, { recursive: true });
      const f = await free();
      await writeFile(HEARTBEAT, JSON.stringify({
        pid: process.pid, at: nowIso(), root, uptimeMin: Math.round(process.uptime() / 60),
        cycles, freeMb: Math.round(f.mb), freePct: Number(f.pct.toFixed(1)),
        lastRun: lastRun ? new Date(lastRun).toISOString() : null,
        lastMode, lastFreedMb: Math.round(lastFreed / 1048576),
        nextCheckAt: new Date(Date.now() + checkMs()).toISOString(),
        ...extra,
      }, null, 1));
    } catch { /* beat nunca derruba o daemon */ }
  };

  const countdown = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (!process.stdout.isTTY) return void setTimeout(resolve, ms);
      const end = Date.now() + ms;
      let tick = 0;
      const t = setInterval(() => {
        const left = Math.max(0, end - Date.now());
        const m = Math.floor(left / 60000);
        const s = Math.floor((left % 60000) / 1000);
        // a cada 10s repuxa a memória real do celular
        if (++tick % 10 === 1) {
          void free().then((f) => {
            process.stdout.write(
              `\r  ${sizeFmt(f.mb * 1048576)} livre (${f.pct.toFixed(1)}%) | proxima verificacao em ${m}m${String(s).padStart(2, "0")}s   `,
            );
          }).catch(() => undefined);
        } else {
          process.stdout.write(`\r  proxima verificacao em ${m}m${String(s).padStart(2, "0")}s   `);
        }
        if (left <= 0) { clearInterval(t); process.stdout.write("\r" + " ".repeat(60) + "\r"); resolve(); }
      }, 1000);
      t.unref?.();
    });

  await log(`daemon up: root=${root} check=${opts.checkMin ?? 30}min run=${opts.runHours ?? 24}h`);
  console.log(`clean-select daemon — ${nowIso()}`);
  console.log(`root: ${root}`);
  console.log(`verifica: ${opts.checkMin ?? cfg.checkMin}min | limpeza: ${opts.runHours ?? cfg.runHours}h | meta livre >=${cfg.freeTargetPct}% | emergencia <${cfg.freeEmergencyPct}%`);
  console.log(`parar: Ctrl+C ou rm ~/.clean_select/lock | heartbeat: ${HEARTBEAT}`);

  for (;;) {
    try {
      reloadCfg(); // .env vale imediatamente, sem reiniciar o daemon
      const f0 = await free();
      const mode = modeFor(f0.pct);
      const due = Date.now() - lastRun > runMs();
      const shouldRun = mode !== "diario" || due;
      cycles++;
      lastMode = mode;

      console.log(`\nciclo #${cycles} — ${nowIso()}`);
      console.log(`  espaco: ${f0.pct.toFixed(1)}% livre (${sizeFmt(f0.mb * 1048576)} de ${sizeFmt(f0.total * 1048576)}) [${f0.source}]`);
      console.log(`  modo: ${mode.toUpperCase()}${due ? " (janela diária)" : shouldRun && mode !== "diario" ? " (espaço apertado)" : ""}`);

      if (!shouldRun) {
        console.log(`  nada a fazer — próxima limpeza em ${Math.max(0, Math.round((runMs() - (Date.now() - lastRun)) / 60000))}min ou se livre < ${cfg.freeTargetPct}%`);
        await beat({ idle: true });
      } else {
        // lock só durante a limpeza: comandos manuais entram entre os ciclos
        let release;
        try {
          release = await acquireLock();
        } catch {
          console.log("  outra execução segurando o lock — ciclo pulado");
          await countdown(checkMs());
          continue;
        }
        const t0 = Date.now();
        try {
        console.log(`  [1/4] varrendo ${root}...`);
        const { findings, dedupeCandidates, projectDirs, stats, scanMs } = await hooks.scan(mode);
        console.log(
          `        ${stats.files} arquivos / ${stats.dirs} pastas (${mb(stats.bytes)} MB) em ${(scanMs / 1000).toFixed(1)}s — ${stats.ignored} ignorados`,
        );

        const auto = findings.filter((x) => allowedInMode(x, mode));
        const skipped = findings.filter((x) => !allowedInMode(x, mode));

        console.log(`  [2/4] classificados: ${findings.length} achados -> ${auto.length} aplicáveis, ${skipped.length} fora do modo`);
        for (const [L, arr] of [...grouped(auto).entries()].sort()) {
          const bytes = arr.reduce((a, x) => a + x.size, 0);
          console.log(`        ${L} ${(NAMES[L] ?? "").padEnd(18)} ${String(arr.length).padStart(5)} itens  ${asciiBar(bytes, Math.max(1, ...[...grouped(auto).values()].map((g) => g.reduce((a, x) => a + x.size, 0))), 15)} ${mb(bytes)} MB`);
          for (const x of [...arr].sort((a, b) => b.size - a.size).slice(0, 3)) {
            console.log(`             ${mb(x.size).padStart(8)} MB  ${x.rel.slice(0, 70)}`);
          }
        }
        if (skipped.length) {
          const bytes = skipped.reduce((a, x) => a + x.size, 0);
          console.log(`        retidos p/ execução manual: ${skipped.length} itens, ${mb(bytes)} MB ([confirmar]/K/L)`);
        }

        const cwds = await runningCwds();
        if (cwds.length) console.log(`        bots ativos (cwd): ${cwds.join(", ")} — projetos pulados`);

        console.log(`  [3/4] movendo p/ lixeira...`);
        const r = await applyFindings(auto, { cwds, root });
        console.log(`        regras: ${r.removed} movidos, ${r.failed} falhas, ${mb(r.freed)} MB`);

        const { groups } = await findDuplicates(dedupeCandidates, {
          priorities: rules.dedupePriority,
          autoZones: rules.dedupeAutoZones,
          auto: mode !== "emergencia",
          autoFull: !!cfg.dedupeAutoFull,
          projectDirs,
          onProgress: (m) => console.log(`        ...${m}`),
        });
        const dupFindings: Finding[] = [];
        const meta = new Map<string, { hash: string; keptOriginal: string }>();
        for (const g of groups) {
          for (const x of g.remove) {
            dupFindings.push({ path: x.path, rel: x.rel, size: x.size, mtimeMs: x.mtimeMs, ruleId: "M", letter: "M", level: "auto" });
            meta.set(x.path, { hash: g.hash, keptOriginal: g.keep!.path });
          }
        }
        const dupMb = dupFindings.reduce((a, x) => a + x.size, 0);
        console.log(`        dedupe: ${groups.length} grupos -> ${dupFindings.length} cópias, ${mb(dupMb)} MB`);
        for (const g of groups.filter((g) => g.remove.length).slice(0, 3)) {
          console.log(`             ${mb(g.size)} MB x${g.files.length} — mantém ${g.keep!.rel.slice(0, 55)}`);
        }
        const rd = await applyFindings(dupFindings, { meta: (f) => meta.get(f.path) ?? {}, cwds, root });

        const freed = r.freed + rd.freed;
        lastFreed = freed;
        const freedByLetter: Record<string, number> = { ...r.byLetter };
        freedByLetter.M = (freedByLetter.M ?? 0) + rd.freed;

        const trashedBefore = await trashSize();
        // emergência: lixeira não protege — ela ocupa o espaço que queremos liberar
        if (mode === "emergencia" && cfg.trashEmergencyPurge) {
          const purged = await emptyTrash();
          if (purged > 0) console.log(`        EMERGÊNCIA: lixeira esvaziada de vez (+${sizeFmt(purged)})`);
        } else {
          await purgeOldTrash();
        }
        const trashedAfter = await trashSize();
        await recordRun({
          date: new Date().toISOString(), profile: `daemon:${mode}`,
          freedByLetter, freedTotal: freed, durationMs: Date.now() - t0,
        });
        lastRun = Date.now();

        const f1 = await free();
        console.log(`  [4/4] resultado:`);
        console.log(`        lixeira: ${mb(trashedAfter)} MB${trashedBefore !== trashedAfter ? ` (liberou ${mb(Math.max(0, trashedBefore - trashedAfter))} MB)` : ""}`);
        console.log(`        espaco:  ${f1.pct.toFixed(1)}% livre  (${f1.mb > f0.mb ? "+" : "-"}${sizeFmt(Math.abs(f1.mb - f0.mb) * 1048576)} real)`);
        console.log(`        ciclo: ${r.removed + rd.removed} itens, ${mb(freed)} MB, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        await log(`ciclo ${mode}: ${r.removed + rd.removed} itens ${Math.round(freed / 1048576)}MB livre=${f1.pct.toFixed(1)}%`);
        await beat({ mode, freedMb: Math.round(freed / 1048576) });
        } finally {
          await release(); // solta o lock — idle deixa comandos manuais entrarem
        }
      }
    } catch (e) {
      await log(`daemon erro: ${String(e)}`);
      console.error("  ciclo falhou (seguindo):", String(e));
    }
    await countdown(checkMs());
  }
}

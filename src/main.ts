import { parseArgs } from "node:util";
import { readFile, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FileEntry, Finding, Rules } from "./types.ts";
import { scan } from "./scanner.ts";
import {
  appBackupFindings, classifyFile, emptyDirFindings, extractedArchiveFindings,
  nestedDupFindings, nodeModulesFindings, protectedReason, rotateBackups,
  type ClassifyCtx, type StructureInfo,
} from "./classifier.ts";
import {
  acquireLock, applyFindings, checkFuses, confirmPrompt, FuseError, runningCwds,
} from "./cleaner.ts";
import { findDuplicates } from "./dedupe.ts";
import { emptyTrash, listTrash, log, purgeOldTrash, restore, trashSize } from "./trash.ts";
import { LETTER_NAMES, printDupReport, printFindings, scanSummary } from "./report.ts";
import { loadHistory, recordRun, statsReport, growthAlerts } from "./stats.ts";
import { diffMap, loadSizes, refreshMap } from "./map.ts";
import { remoteLoop } from "./remote.ts";
import { matchAny, mb, normRel } from "./util.ts";

const exec = promisify(execFile);
const BASE = join(import.meta.dirname, "..");
const RULES_FILE = join(BASE, "rules.json");
const IGNORE_FILE = join(BASE, "ignore.json");
const REPORT_FILE = "/sdcard/Download/clean_select_relatorio.txt";
const RULES_VERSION = 1;

const DEFAULT_ROOT = "/sdcard";

const { values: v } = parseArgs({
  args: process.argv.slice(2),
  strict: false,
  options: {
    scan: { type: "boolean" }, apply: { type: "boolean" }, agressivo: { type: "boolean" },
    perfil: { type: "string" }, alvo: { type: "string" }, only: { type: "string" },
    skip: { type: "string" }, dup: { type: "boolean" }, auto: { type: "boolean" },
    "prune-modules": { type: "boolean" }, termux: { type: "boolean" }, root: { type: "string" },
    age: { type: "string" }, restore: { type: "string" }, "empty-trash": { type: "boolean" },
    "refresh-map": { type: "boolean" }, "diff-map": { type: "boolean" }, stats: { type: "boolean" },
    ignore: { type: "string" }, unignore: { type: "string" }, explicar: { type: "string" },
    doctor: { type: "boolean" }, "instalar-agenda": { type: "boolean" },
    "confirmo-grande": { type: "boolean" }, top: { type: "string" }, remote: { type: "boolean" },
    daemon: { type: "boolean" }, intervalo: { type: "string" }, "a-cada": { type: "string" },
    help: { type: "boolean" },
  },
});

async function loadRules(): Promise<Rules> {
  const r = JSON.parse(await readFile(RULES_FILE, "utf8")) as Rules;
  if (r.version > RULES_VERSION) throw new Error(`rules.json v${r.version} > suportado v${RULES_VERSION}`);
  return r;
}

async function loadIgnore(): Promise<string[]> {
  try {
    return (JSON.parse(await readFile(IGNORE_FILE, "utf8")) as { ignore: string[] }).ignore ?? [];
  } catch {
    return [];
  }
}

const PROFILES: Record<string, { only?: string[]; aggressive?: boolean; dupAuto?: boolean; prune?: boolean }> = {
  diario:     { only: ["D", "E", "F", "G", "H", "I"], dupAuto: true },
  semanal:    { only: ["A", "B", "D", "E", "F", "G", "H", "I", "J"], dupAuto: true, prune: true },
  profundo:   { aggressive: true, prune: true },
  emergencia: { only: ["D", "E", "H", "I", "M"], dupAuto: true },
};

function letterSet(s?: string): Set<string> | undefined {
  if (!s) return undefined;
  return new Set(s.toUpperCase().split(/[,; ]*/).filter(Boolean));
}

/* =================== varredura + classificação =================== */

async function runScan(root: string, ctx: ClassifyCtx, rules: Rules) {
  const t0 = Date.now();
  const findings: Finding[] = [];
  const info: StructureInfo = { dirs: new Set(), filesIn: new Set(), filesByDir: new Map(), nodeModulesProjects: [] };
  const projectDirs = new Set<string>();
  const pkgJsonDirs = new Set<string>();
  const nmDirs: string[] = [];
  const dedupeCandidates: FileEntry[] = [];
  const topFiles: FileEntry[] = [];
  const interesting = (rel: string) =>
    matchAny(rules.backupDirs, dirname(rel).replace(/\\/g, "/").toLowerCase() + "/") ||
    /backup|backups\/apps/i.test(rel) || /\.(zip|rar|7z|apk|xapk|apkm|apks)$/i.test(rel);

  const dirSizes = new Map<string, number>();
  let seen = 0;
  const stats = await scan({
    root,
    skipDir: undefined,
    onDir: (rel, name) => {
      info.dirs.add(rel);
      if (name === "node_modules") nmDirs.push(rel);
      if (name === ".git") projectDirs.add(dirname(rel).replace(/\\/g, "/"));
    },
    onFile: (e) => {
      const base = basename(e.rel).toLowerCase();
      const parent = dirname(e.rel).replace(/\\/g, "/");
      dirSizes.set(parent, (dirSizes.get(parent) ?? 0) + e.size);
      info.filesIn.add(parent);
      if (++seen % 20000 === 0) console.log(`  …${seen} arquivos`);
      if (base === "package.json" || base === "tsconfig.json" || base === "requirements.txt") {
        pkgJsonDirs.add(parent);
        projectDirs.add(parent);
      }
      const f = classifyFile(e, ctx);
      if (f) findings.push(f);
      else if (e.size === 0 && !protectedReason(e.rel) && !matchAny(ctx.ignoreGlobs, e.rel)
        && (!ctx.only || ctx.only.has("J")) && !ctx.skip?.has("J")) {
        findings.push({ ...e, ruleId: "J.zero", letter: "J", level: "confirmar", note: "arquivo de 0 bytes" });
      }
      if (interesting(e.rel)) {
        const arr = info.filesByDir.get(parent) ?? [];
        arr.push(e);
        info.filesByDir.set(parent, arr);
      }
      if (e.size >= 4096) dedupeCandidates.push(e);
      if (e.size >= 50 * 1024 * 1024) {
        topFiles.push(e);
        topFiles.sort((a, b) => b.size - a.size);
        if (topFiles.length > 60) topFiles.pop();
      }
    },
  });

  for (const d of nmDirs) {
    const parent = dirname(d).replace(/\\/g, "/");
    if (pkgJsonDirs.has(parent)) info.nodeModulesProjects.push({ dir: d, parent });
  }

  const structural: Finding[] = [
    ...rotateBackups(info, rules.backupDirs, ctx),
    ...nodeModulesFindings(info),
    ...nestedDupFindings(info),
    ...emptyDirFindings(info),
    ...appBackupFindings(info),
  ];
  // zips extraídos: avaliar sobre os arquivos já coletados
  const flat: FileEntry[] = [];
  for (const arr of info.filesByDir.values()) flat.push(...arr);
  structural.push(...extractedArchiveFindings(flat, info));

  const allowed = (f: Finding) =>
    (!ctx.only || ctx.only.has(f.letter)) && !ctx.skip?.has(f.letter);
  const all = [...findings, ...structural].filter(allowed);

  return { stats, findings: all, dedupeCandidates, topFiles, projectDirs, info, dirSizes, ms: Date.now() - t0 };
}

/* =================== aplicação =================== */

async function applyAll(findings: Finding[], root: string, rules: Rules, totalFiles: number): Promise<void> {
  checkFuses(findings.filter((f) => f.level !== "relatorio"), totalFiles, rules.limits, !!v["confirmo-grande"]);
  const auto = findings.filter((f) => f.level === "auto" && f.letter !== "K");
  const conf = findings.filter((f) => f.level === "confirmar");
  const cwds = await runningCwds();
  if (cwds.length) console.log(`bots rodando em: ${cwds.join(", ")} (projetos serão pulados)`);

  // --alvo N GB: para assim que o espaço livre atingir a meta
  const alvoBytes = v.alvo ? Number(v.alvo) * 1024 ** 3 : Infinity;
  const freeNow = async () => {
    try { const s = await statfs(root); return s.bavail * s.bsize; } catch { return 0; }
  };
  const reachedTarget = async () => (await freeNow()) >= alvoBytes;

  let freedTotal = 0;
  const freedByLetter: Record<string, number> = {};
  const doApply = async (list: Finding[]) => {
    const r = await applyFindings(list, { cwds, root });
    freedTotal += r.freed;
    for (const [k, bytes] of Object.entries(r.byLetter)) {
      freedByLetter[k] = (freedByLetter[k] ?? 0) + bytes;
    }
    console.log(`  removidos ${r.removed}, falhas ${r.failed}, ${mb(r.freed)} MB`);
  };

  if (auto.length && !(await reachedTarget())) {
    console.log(`\n[auto] ${auto.length} itens, ${mb(auto.reduce((a, f) => a + f.size, 0))} MB`);
    await doApply(auto);
  }
  const byLetter = new Map<string, Finding[]>();
  for (const f of conf) {
    const a = byLetter.get(f.letter) ?? [];
    a.push(f);
    byLetter.set(f.letter, a);
  }
  for (const [L, arr] of byLetter) {
    if (await reachedTarget()) { console.log(`\nalvo ${v.alvo}GB atingido — parando.`); break; }
    const bytes = arr.reduce((a, f) => a + f.size, 0);
    console.log(`\n[confirmar] ${L} — ${LETTER_NAMES[L] ?? ""}: ${arr.length} itens, ${mb(bytes)} MB`);
    if (await confirmPrompt(`aplicar categoria ${L}?`)) await doApply(arr);
    else console.log("  pulado.");
  }
  await recordRun({
    date: new Date().toISOString(),
    profile: String(v.perfil ?? "manual"),
    freedByLetter, freedTotal, durationMs: 0,
  });
  try {
    await writeFile(REPORT_FILE, printFindings(findings, Number(v.top ?? 10)));
  } catch { /* fora do Android: ignora */ }
}

/* =================== subcomandos simples =================== */

async function editIgnore(add?: string, del?: string): Promise<void> {
  const cur = new Set(await loadIgnore());
  if (add) cur.add(add);
  if (del) cur.delete(del);
  await writeFile(IGNORE_FILE, JSON.stringify({ ignore: [...cur] }, null, 2));
  console.log(`ignore.json: ${cur.size} entradas.`);
}

async function doctor(root: string): Promise<void> {
  const ok = (b: boolean, msg: string) => console.log(`${b ? "OK " : "FALHA"} ${msg}`);
  const [maj, min] = process.versions.node.split(".").map(Number);
  ok(maj > 22 || (maj === 22 && min >= 18), `node ${process.versions.node} (precisa 22.18+)`);
  try {
    const probe = join(root, ".clean_select_probe");
    await writeFile(probe, "x");
    const { rm } = await import("node:fs/promises");
    await rm(probe);
    ok(true, `escrita em ${root}`);
  } catch {
    ok(false, `sem permissão de escrita em ${root} (rode termux-setup-storage)`);
  }
  try {
    const dirs = (await readFile(join(BASE, "reference", "dirs.txt"), "utf8")).split("\n").filter(Boolean);
    ok(dirs.length > 0, `reference/dirs.txt: ${dirs.length} pastas`);
  } catch {
    ok(false, "reference/dirs.txt ausente — copie o mapa ou rode --refresh-map");
  }
  try {
    const r = await loadRules();
    ok(Array.isArray(r.rules) && r.rules.length > 0, `rules.json v${r.version}: ${r.rules.length} regras`);
  } catch (e) {
    ok(false, `rules.json inválido: ${String(e)}`);
  }
  try {
    const s = await statfs(root);
    ok(true, `espaço livre: ${mb(s.bavail * s.bsize)} MB / total ${mb(s.blocks * s.bsize)} MB`);
  } catch {
    ok(false, "statfs indisponível");
  }
  console.log(`lixeira: ${mb(await trashSize())} MB`);
}

/* =================== main =================== */

async function main(): Promise<void> {
  const root = resolve(String(v.root ?? DEFAULT_ROOT)).replace(/\\/g, "/");
  const rules = await loadRules();
  await purgeOldTrash();

  // subcomandos que não varrem
  if (v.help) { console.log(HELP); return; }
  if (v.doctor) return doctor(root);
  if (v.stats) return void console.log(await statsReport());
  if (v["refresh-map"]) { await refreshMap(root); console.log("mapa regenerado em reference/."); return; }
  if (v["diff-map"]) {
    const novos = await diffMap(root);
    console.log(novos.length ? `pastas novas (revisar):\n${novos.map((d) => "  " + d).join("\n")}` : "nenhuma pasta nova.");
    return;
  }
  if (v.restore !== undefined) {
    const okv = await restore(String(v.restore));
    console.log(okv ? "restaurado." : "não encontrado. Ids:");
    if (!okv) for (const e of await listTrash()) console.log(`  ${e.id}  ${e.original}`);
    return;
  }
  if (v["empty-trash"]) { console.log(`lixeira esvaziada: ${mb(await emptyTrash())} MB`); return; }
  if (v.ignore !== undefined || v.unignore !== undefined) return editIgnore(v.ignore as string, v.unignore as string);
  if (v["instalar-agenda"]) {
    const home = process.env.HOME ?? "";
    // 1) boot: sobe o daemon toda vez que o Termux abre (Termux:Boot)
    try {
      const bootDir = join(home, ".termux", "boot");
      const { mkdir: mk, chmod } = await import("node:fs/promises");
      await mk(bootDir, { recursive: true });
      const boot = join(bootDir, "clean_select.sh");
      await writeFile(boot,
        `#!/data/data/com.termux/files/usr/bin/sh\n` +
        `termux-wake-lock\n` +
        `cd "${BASE}" && node src/main.ts --daemon --root /sdcard >> ${home}/.clean_select/daemon.out 2>&1 &\n`);
      await chmod(boot, 0o755);
      console.log(`boot instalado: ${boot} (o daemon sobe junto com o Termux)`);
    } catch {
      console.log("sem Termux:Boot — o daemon pode ser iniciado manualmente com --daemon");
    }
    // 2) job diário (madrugada) + semanal (domingo) via termux-job-scheduler
    try {
      await exec("termux-job-scheduler", ["--script", join(BASE, "run.sh"), "--period-ms", "86400000", "--persisted", "true"]);
      await exec("termux-job-scheduler", ["--script", join(BASE, "run-semanal.sh"), "--period-ms", "604800000", "--persisted", "true"]);
      console.log("agendas instaladas: diária (24h) e semanal (7d) via termux-job-scheduler.");
    } catch {
      console.log("termux-job-scheduler ausente — instale o app Termux:API. " +
        "Enquanto isso, o --daemon já cobre a automação.");
    }
    console.log("resumo: daemon (boot + --daemon) faz a limpeza contínua; " +
      "os jobs são redundância caso o daemon morra.");
    return;
  }
  if (v.daemon) {
    const release2 = await acquireLock();
    try {
      const { daemonLoop } = await import("./daemon.ts");
      await daemonLoop(root, rules, {
        scan: async (mode) => {
          const ignore = await loadIgnore();
          // quanto mais apertado o espaço, menor a idade mínima e maior o escopo
          const ctx: ClassifyCtx = {
            rules,
            ageDays: mode === "emergencia" ? 0 : mode === "reforco" ? 1 : Number(v.age ?? 3),
            aggressive: mode === "emergencia",
            only: mode === "diario" ? new Set(["D", "E", "F", "G", "H", "I"]) : undefined,
            pruneModules: mode !== "diario",
            termux: !!v.termux,
            ignoreGlobs: ignore,
          };
          const r = await runScan(root, ctx, rules);
          return {
            findings: r.findings,
            dedupeCandidates: r.dedupeCandidates,
            projectDirs: r.projectDirs,
            totalFiles: r.stats.files,
          };
        },
      }, {
        checkMin: Number(v.intervalo ?? 30),
        runHours: Number(v["a-cada"] ?? 24),
      });
    } finally {
      await release2();
    }
    return;
  }
  if (v.explicar !== undefined) {
    const target = normRel(String(v.explicar)).replace(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/?`), "");
    const prot = protectedReason(target);
    if (prot) { console.log(`${target}: PROTEGIDO — ${prot}`); return; }
    const ctx = await makeCtx();
    const fake: FileEntry = { path: join(root, target), rel: target, size: 1, mtimeMs: Date.now() - 1e10 };
    const f = classifyFile(fake, ctx);
    console.log(f ? `${target}: regra ${f.ruleId} [${f.level}] letra ${f.letter}` : `${target}: nenhuma regra (fica de fora)`);
    return;
  }

  async function makeCtx(): Promise<ClassifyCtx> {
    const perfil = PROFILES[String(v.perfil ?? "")];
    return {
      rules,
      ageDays: Number(v.age ?? 3),
      aggressive: !!v.agressivo || !!perfil?.aggressive,
      only: letterSet(String(v.only ?? "")) ?? (perfil?.only ? new Set(perfil.only) : undefined),
      skip: letterSet(String(v.skip ?? "")),
      pruneModules: !!v["prune-modules"] || !!perfil?.prune,
      termux: !!v.termux,
      ignoreGlobs: await loadIgnore(),
    };
  }

  if (v.remote) {
    const ctx = await makeCtx();
    return remoteLoop({
      status: async () => `livre: ${mb((await statfs(root)).bavail * (await statfs(root)).bsize)} MB | lixeira ${mb(await trashSize())} MB`,
      dryRun: async () => {
        const r = await runScan(root, ctx, rules);
        return `${r.findings.length} itens, ${mb(r.findings.reduce((a, f) => a + f.size, 0))} MB`;
      },
      relatorio: async () => printFindings((await runScan(root, ctx, rules)).findings),
      stats: statsReport,
    });
  }

  // primeira execução: --apply bloqueado até existir relatório prévio
  if (v.apply && (await loadHistory()).length === 0) {
    console.error("primeira execução: rode um dry-run antes (--scan). --apply bloqueado.");
    process.exit(2);
  }

  const release = v.apply ? await acquireLock() : async () => {};
  const started = Date.now();
  try {
    const ctx = await makeCtx();
    const { stats, findings, dedupeCandidates, topFiles, projectDirs, dirSizes, ms } = await runScan(root, ctx, rules);
    console.log(scanSummary(stats, ms));

    // L: top maiores arquivos
    const topN = Number(v.top ?? 10);
    if (topFiles.length) {
      console.log(`\n== L — maiores arquivos (50MB+) ==`);
      for (const f of topFiles.slice(0, Math.max(topN, 50))) {
        console.log(`  ${mb(f.size).padStart(9)} MB  ${f.rel}`);
      }
    }

    const actionable = findings.filter((f) => f.level !== "relatorio");
    const reportOnly = findings.filter((f) => f.level === "relatorio");
    console.log(printFindings(findings, topN));
    console.log(`\ntotal sugerido: ${actionable.length} itens, ${mb(actionable.reduce((a, f) => a + f.size, 0))} MB` +
      ` | relatório-only: ${reportOnly.length}`);

    // M: dedupe
    if (v.dup || v.auto || PROFILES[String(v.perfil ?? "")]?.dupAuto) {
      const perfil = PROFILES[String(v.perfil ?? "")];
      const { groups } = await findDuplicates(dedupeCandidates, {
        priorities: rules.dedupePriority,
        autoZones: rules.dedupeAutoZones,
        auto: !!v.auto || !!perfil?.dupAuto,
        projectDirs,
        onProgress: (m) => console.log(m),
      });
      console.log(printDupReport(groups));
      if (v.apply) {
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
        if (v.auto || (await confirmPrompt(`remover ${dupFindings.length} duplicados (ver top-20 acima)?`))) {
          const cwds = await runningCwds();
          const r = await applyFindings(dupFindings, { meta: (f) => meta.get(f.path) ?? {}, cwds, root });
          console.log(`dedupe: ${r.removed} removidos, ${mb(r.freed)} MB liberados.`);
        }
      }
    }

    // alerta de crescimento (P): compara com o reference/tamanhos.txt do mapa anterior
    const oldSizes = await loadSizes();
    const prefix = root.replace(/\/$/, "");
    const newSizes = new Map<string, number>();
    for (const [d, s] of dirSizes) newSizes.set(`${prefix}/${d}`, s);
    const alerts = growthAlerts(oldSizes, newSizes);
    if (alerts.length) console.log(`\n!! crescimento >500MB/7d:\n${alerts.map((a) => "  " + a).join("\n")}`);

    if (!v.apply) {
      console.log("\ndry-run. Use --apply para executar (pede confirmação por categoria).");
      return;
    }
    await applyAll(actionable, root, rules, stats.files);
    try {
      const after = await statfs(root);
      console.log(`espaço livre agora: ${mb(after.bavail * after.bsize)} MB`);
    } catch { /* ok */ }
    console.log(`concluído em ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (e) {
    if (e instanceof FuseError) {
      console.error(`ABORTADO — ${e.message}`);
      process.exit(3);
    }
    throw e;
  } finally {
    await release();
    await log(`run done root=${root}`);
  }
}

const HELP = `clean-select — limpador seguro p/ Termux (dry-run por padrão)

uso: node src/main.ts [--scan] [--apply] [flags]

  --perfil diario|semanal|profundo|emergencia   perfil de limpeza
  --only A,D,M / --skip B                       filtra letras de regra
  --dup [--auto] [--apply]                      deduplicação (M)
  --prune-modules                               poda dentro de node_modules (A2)
  --agressivo                                   habilita regras [AGR]
  --root <pasta>                                raiz alternativa (testes)
  --age <dias>                                  idade mínima (default 3)
  --alvo <GB>                                   parar ao atingir N GB livres
  --restore <id>  --empty-trash                 lixeira
  --refresh-map  --diff-map                     mapa de pastas (reference/)
  --ignore <glob>  --unignore <glob>  --explicar <caminho>
  --stats  --doctor  --instalar-agenda  --remote
  --daemon [--intervalo <min>] [--a-cada <h>]   piloto automático contínuo
  --confirmo-grande                             libera limpeza >5GB/>20%
  --top <n>                                     quantos itens por categoria
`;

await main();

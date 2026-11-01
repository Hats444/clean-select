import { lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import type { Finding } from "./types.ts";
import { CS_HOME, LOCK_FILE, mb } from "./util.ts";
import { log, toTrashBatch } from "./trash.ts";

/* ================= N: fusíveis ================= */

export class FuseError extends Error {}

export function checkFuses(
  findings: Finding[],
  totalFiles: number,
  limits: { maxBytes: number; maxPercent: number },
  confirmBig: boolean,
): void {
  const bytes = findings.reduce((a, f) => a + f.size, 0);
  const pct = totalFiles > 0 ? (findings.length / totalFiles) * 100 : 0;
  if (!confirmBig && (bytes > limits.maxBytes || pct > limits.maxPercent)) {
    throw new FuseError(
      `fusível: ${mb(bytes)} MB (${pct.toFixed(1)}% dos arquivos) excede o limite ` +
      `${mb(limits.maxBytes)} MB / ${limits.maxPercent}%. Reexecute com --confirmo-grande.`,
    );
  }
}

export async function acquireLock(): Promise<() => Promise<void>> {
  await mkdir(CS_HOME, { recursive: true });
  try {
    await writeFile(LOCK_FILE, String(process.pid), { flag: "wx" });
  } catch {
    // lock existe: se o processo morreu, remove e tenta de novo
    let alive = false;
    try {
      const pid = Number(await readFile(LOCK_FILE, "utf8"));
      process.kill(pid, 0);
      alive = true;
    } catch { /* pid morto */ }
    if (alive) throw new FuseError("outra execução em andamento (lockfile).");
    await rm(LOCK_FILE, { force: true });
    await writeFile(LOCK_FILE, String(process.pid), { flag: "wx" });
  }
  return async () => { await rm(LOCK_FILE, { force: true }); };
}

/** cwd de processos node/python vivos (via /proc). Fora do Linux: vazio. */
export async function runningCwds(): Promise<string[]> {
  const out: string[] = [];
  try {
    const pids = await readdir("/proc");
    for (const pid of pids) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const name = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
        if (!/node|python/i.test(name)) continue;
        out.push(await readlink(`/proc/${pid}/cwd`));
      } catch { /* sem acesso */ }
    }
  } catch { /* /proc inexistente (Windows etc.) */ }
  return out;
}

export function underRunningProject(rel: string, cwds: string[], root: string): boolean {
  const abs = `${root}/${rel}`.replace(/\\/g, "/");
  return cwds.some((c) => abs.startsWith(c.replace(/\\/g, "/")));
}

/** Reconfirma no disco antes de remover. */
export async function recheck(f: Finding): Promise<boolean> {
  try {
    const st = await lstat(f.path);
    if (st.isSymbolicLink()) return false;
    if (st.isFile() && (st.size !== f.size || st.mtimeMs !== f.mtimeMs)) return false;
    return true;
  } catch {
    return false;
  }
}

export async function confirmPrompt(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${question} [s/N] `);
  rl.close();
  return /^s(im)?$/i.test(a.trim());
}

export interface ApplyResult {
  removed: number; freed: number; failed: number;
  /** MB liberada por letra de regra (só sucessos) */
  byLetter: Record<string, number>;
}

/** Executa a remoção: tudo passa pela lixeira, com rechecagem por arquivo. */
export async function applyFindings(findings: Finding[], opts: {
  meta?: (f: Finding) => { hash?: string; keptOriginal?: string };
  cwds?: string[];
  root?: string;
  runId?: string;
  /** retorna true p/ apagar DIRETO sem lixeira (emergência: a cópia encheria o disco) */
  direct?: (f: Finding) => boolean;
  onProgress?: (done: number, total: number) => void;
  /** chamada a cada lote de itens; true = parar de aplicar (meta atingida) */
  shouldStop?: () => Promise<boolean>;
} = {}): Promise<ApplyResult> {
  const res: ApplyResult = { removed: 0, freed: 0, failed: 0, byLetter: {} };

  // 1) rechecagem + split trash vs delete direto
  const toTrashList: { f: Finding; path: string; meta?: { hash?: string; keptOriginal?: string } }[] = [];
  const toDelete: Finding[] = [];
  for (const f of findings) {
    if (opts.cwds && opts.root && underRunningProject(f.rel, opts.cwds, opts.root)) {
      await log(`skip (projeto rodando): ${f.rel}`);
      continue;
    }
    if (!(await recheck(f))) { res.failed++; continue; }
    if (opts.direct?.(f)) toDelete.push(f);
    else toTrashList.push({ f, path: f.path, meta: opts.meta?.(f) });
  }

  const STOP_CHECK = 250;
  const checkStop = async () => opts.shouldStop && (await opts.shouldStop());

  // 2) delete direto (emergência) — rm sem copiar nada
  for (const f of toDelete) {
    if ((res.removed + res.failed) % STOP_CHECK === 0 && (await checkStop())) break;
    try {
      await rm(f.path, { recursive: true, force: true });
      res.removed++;
      res.freed += f.size;
      res.byLetter[f.letter] = (res.byLetter[f.letter] ?? 0) + f.size;
    } catch {
      res.failed++;
    }
    opts.onProgress?.(res.removed + res.failed, findings.length);
  }

  // 3) lixeira EM LOTE — manifest uma vez só (era por item = O(n²))
  if (await checkStop()) toTrashList.length = 0;
  const ids = await toTrashBatch(
    toTrashList.map((x) => ({ path: x.path, meta: { ...x.meta, } })),
    opts.runId,
  );
  for (const x of toTrashList) {
    if (ids.has(x.path)) {
      res.removed++;
      res.freed += x.f.size;
      res.byLetter[x.f.letter] = (res.byLetter[x.f.letter] ?? 0) + x.f.size;
    } else res.failed++;
    opts.onProgress?.(res.removed + res.failed, findings.length);
  }
  return res;
}

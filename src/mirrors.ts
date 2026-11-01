import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { scan } from "./scanner.ts";
import type { FileEntry } from "./types.ts";
import { mb } from "./util.ts";

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(path);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

async function fingerprint(absDir: string): Promise<Map<string, string>> {
  const files: FileEntry[] = [];
  await scan({ root: absDir, onFile: (e) => files.push(e) });
  const fp = new Map<string, string>();
  for (const f of files) {
    try {
      fp.set(f.rel.toLowerCase(), `${f.size}:${await sha256(f.path)}`);
    } catch { /* some */ }
  }
  return fp;
}

export interface MirrorResult {
  a: string;
  b: string;
  totalA: number;
  totalB: number;
  identical: number;
  onlyInA: number;
  onlyInB: number;
  divergent: number;
  /** 100% idênticas => b pode ser removido com segurança */
  safeToRemove: boolean;
}

export async function compareDirs(root: string, a: string, b: string): Promise<MirrorResult | null> {
  try {
    await access(join(root, a));
    await access(join(root, b));
  } catch {
    return null;
  }
  const [fa, fb] = await Promise.all([fingerprint(join(root, a)), fingerprint(join(root, b))]);
  let identical = 0, divergent = 0;
  for (const [rel, ha] of fa) {
    const hb = fb.get(rel);
    if (hb === undefined) continue;
    if (ha === hb) identical++;
    else divergent++;
  }
  return {
    a, b,
    totalA: fa.size, totalB: fb.size,
    identical,
    onlyInA: fa.size - identical - divergent,
    onlyInB: fb.size - identical - divergent,
    divergent,
    safeToRemove: identical === fa.size && fa.size === fb.size && fa.size > 0,
  };
}

/** C: pares de espelho conhecidos do mapa real. */
export const MIRROR_PAIRS: [string, string][] = [
  // hanork-beta/home/container/* espelha hanork-beta/*
  ...["commands", "docs", "handlers", "utils"].map(
    (n): [string, string] => [`download/hanork-beta/home/container/${n}`, `download/hanork-beta/${n}`],
  ),
  // pasta solta (fora de Download) também é coberta
  ...["commands", "docs", "handlers", "utils"].map(
    (n): [string, string] => [`hanork-beta/home/container/${n}`, `hanork-beta/${n}`],
  ),
];

/** Sobreposição entre dois projetos inteiros (% de arquivos iguais). */
export async function overlapReport(root: string, a: string, b: string): Promise<string | null> {
  const r = await compareDirs(root, a, b);
  if (!r) return null;
  const pct = r.totalA ? Math.round((r.identical / r.totalA) * 100) : 0;
  return `${a} vs ${b}: ${pct}% iguais (${r.identical}/${r.totalA}), ` +
    `${r.divergent} divergentes, ${r.onlyInA} só em A, ${r.onlyInB} só em B`;
}

export function mirrorLine(r: MirrorResult): string {
  if (r.safeToRemove) return `${r.b} é espelho 100% idêntico de ${r.a} (${r.totalA} arquivos) — removível`;
  return `${r.a} vs ${r.b}: ${r.identical} iguais, ${r.divergent} divergentes, ` +
    `${r.onlyInA}+${r.onlyInB} exclusivos — só relatório`;
}

/** L: tamanho por projeto separando node_modules / cache / logs / backups. */
export function projectSizes(dirSizes: Map<string, number>, top = 10): string[] {
  type Bucket = { nm: number; cache: number; logs: number; backups: number; rest: number };
  const byProj = new Map<string, Bucket>();
  for (const [dir, size] of dirSizes) {
    const parts = dir.split("/");
    const proj = parts.slice(0, 2).join("/");
    const b = byProj.get(proj) ?? { nm: 0, cache: 0, logs: 0, backups: 0, rest: 0 };
    const dl = dir.toLowerCase();
    if (dl.includes("/node_modules")) b.nm += size;
    else if (/\/(logs?)\b/.test(dl)) b.logs += size;
    else if (/\/(cache|tmp|temp|\.cache|_cacache)\b/.test(dl)) b.cache += size;
    else if (/\/backups?\b/.test(dl)) b.backups += size;
    else b.rest += size;
    byProj.set(proj, b);
  }
  const rows = [...byProj.entries()]
    .map(([p, b]) => ({ p, total: b.nm + b.cache + b.logs + b.backups + b.rest, b }))
    .sort((x, y) => y.total - x.total)
    .slice(0, top);
  return rows.map(({ p, total, b }) =>
    `  ${mb(total).padStart(9)} MB  ${p}  (nm ${mb(b.nm)} | cache ${mb(b.cache)} | logs ${mb(b.logs)} | bkp ${mb(b.backups)} | resto ${mb(b.rest)})`,
  );
}

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileEntry } from "./types.ts";
import { HASH_INDEX, matchAny } from "./util.ts";
import { protectedReason } from "./classifier.ts";
import { cfg } from "./config.ts";

const MIN_SIZE = cfg.dedupeMinKb * 1024;
const PART = cfg.dedupePartialKb * 1024;

export type Zone = "protected" | "excluded" | "dedupe";

export interface DupFile extends FileEntry { zone: Zone; account?: string }

export interface DupGroup {
  hash: string;
  size: number;
  files: DupFile[];
  keep?: DupFile;
  remove: DupFile[];
  reportOnly: boolean;
  reason: string;
}

const ACCOUNT_RE = /(^|\/)accounts\/(\d+)\/media(\/|$)/i;

/** Zonas M: protected nunca é removido; excluded nem entra; dedupe participa. */
export function zoneOf(rel: string, projectDirs: Set<string>): Zone {
  const relL = rel.toLowerCase();
  if (relL.startsWith("android/media/") || ACCOUNT_RE.test(relL)) return "protected";
  if (relL.startsWith("dcim/camera/")) return "protected"; // pode ser o mantido, nunca o removido
  if (relL.includes("/node_modules/") || relL.includes("/.git/")) return "excluded";
  for (const p of projectDirs) {
    if (relL === p || relL.startsWith(p + "/")) return "excluded";
  }
  if (protectedReason(rel)) return "excluded";
  return "dedupe";
}

export function accountOf(rel: string): string | undefined {
  const m = ACCOUNT_RE.exec(rel.toLowerCase());
  return m?.[2];
}

async function partialHash(path: string, size: number): Promise<string> {
  const h = createHash("sha256");
  h.update(String(size));
  const fh = await open(path, "r");
  try {
    const buf = Buffer.allocUnsafe(Math.min(PART, size));
    const head = await fh.read(buf, 0, buf.length, 0);
    h.update(buf.subarray(0, head.bytesRead));
    if (size > PART) {
      const tail = await fh.read(buf, 0, Math.min(PART, size), Math.max(0, size - PART));
      h.update(buf.subarray(0, tail.bytesRead));
    }
  } finally {
    await fh.close();
  }
  return h.digest("hex");
}

function fullHash(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(path);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

/** Comparação byte a byte antes de remover (fusível final do dedupe). */
export async function sameBytes(a: string, b: string): Promise<boolean> {
  const [fa, fb] = await Promise.all([open(a, "r"), open(b, "r")]);
  try {
    const ba = Buffer.allocUnsafe(256 * 1024);
    const bb = Buffer.allocUnsafe(256 * 1024);
    let pos = 0;
    for (;;) {
      const [ra, rb] = await Promise.all([
        fa.read(ba, 0, ba.length, pos),
        fb.read(bb, 0, bb.length, pos),
      ]);
      if (ra.bytesRead !== rb.bytesRead) return false;
      if (ra.bytesRead === 0) return true;
      if (!ba.subarray(0, ra.bytesRead).equals(bb.subarray(0, rb.bytesRead))) return false;
      pos += ra.bytesRead;
    }
  } finally {
    await Promise.all([fa.close(), fb.close()]);
  }
}

/* cache incremental: caminho + tamanho + mtime -> sha256 */
type HashCache = Record<string, { size: number; mtime: number; hash: string }>;

async function loadIndex(): Promise<HashCache> {
  try {
    return JSON.parse(await readFile(HASH_INDEX, "utf8")) as HashCache;
  } catch {
    return {};
  }
}

async function saveIndex(idx: HashCache): Promise<void> {
  await mkdir(dirname(HASH_INDEX), { recursive: true });
  const tmp = HASH_INDEX + ".tmp";
  await writeFile(tmp, JSON.stringify(idx));
  const { rename } = await import("node:fs/promises");
  await rename(tmp, HASH_INDEX);
}

function priorityOf(rel: string, priorities: string[]): number {
  const relL = rel.toLowerCase();
  for (let i = 0; i < priorities.length; i++) {
    if (matchAny([priorities[i]], relL)) return i;
  }
  return priorities.length;
}

function pickKeep(files: DupFile[], priorities: string[]): { keep: DupFile; reason: string } {
  const sorted = [...files].sort((a, b) => {
    const pa = priorityOf(a.rel, priorities);
    const pb = priorityOf(b.rel, priorities);
    if (pa !== pb) return pa - pb;
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    return a.rel.length - b.rel.length;
  });
  const k = sorted[0];
  return { keep: k, reason: `prioridade ${priorityOf(k.rel, priorities)} / mtime mais antigo / caminho mais curto` };
}

export interface DupOptions {
  priorities: string[];
  autoZones: string[];   // globs das zonas seguras p/ --auto
  auto: boolean;         // --auto: só zonas seguras
  /** auto total: qualquer cópia fora da zona protegida pode sair */
  autoFull?: boolean;
  projectDirs: Set<string>;
  onProgress?: (msg: string) => void;
}

/**
 * Pipeline M: tamanho -> hash parcial -> sha256 (com cache) -> byte a byte.
 * Nunca deduplica entre contas diferentes (accounts/N).
 */
export async function findDuplicates(files: FileEntry[], opts: DupOptions): Promise<{
  groups: DupGroup[]; index: HashCache;
}> {
  const idx = await loadIndex();
  const cand: DupFile[] = [];
  for (const f of files) {
    if (f.size < MIN_SIZE || f.size === 0) continue;
    const zone = zoneOf(f.rel, opts.projectDirs);
    if (zone === "excluded") continue;
    if (opts.auto && !opts.autoFull && zone !== "protected" && !matchAny(opts.autoZones, f.rel.toLowerCase())) continue;
    cand.push({ ...f, zone, account: accountOf(f.rel) });
  }

  // 1) por tamanho
  const bySize = new Map<number, DupFile[]>();
  for (const f of cand) {
    const arr = bySize.get(f.size) ?? [];
    arr.push(f);
    bySize.set(f.size, arr);
  }

  const groups: DupGroup[] = [];
  let done = 0;
  for (const arr of bySize.values()) {
    if (arr.length < 2) continue;
    // 2) hash parcial
    const byPartial = new Map<string, DupFile[]>();
    for (const f of arr) {
      let ph: string;
      try { ph = await partialHash(f.path, f.size); } catch { continue; }
      const a2 = byPartial.get(ph) ?? [];
      a2.push(f);
      byPartial.set(ph, a2);
    }
    for (const parr of byPartial.values()) {
      if (parr.length < 2) continue;
      // 3) sha256 completo por stream, separando por conta (nunca cruzar contas)
      const byHash = new Map<string, DupFile[]>();
      for (const f of parr) {
        let h: string;
        const key = f.path;
        const c = idx[key];
        if (c && c.size === f.size && c.mtime === f.mtimeMs) {
          h = c.hash;
        } else {
          try { h = await fullHash(f.path); } catch { continue; }
          idx[key] = { size: f.size, mtime: f.mtimeMs, hash: h };
        }
        const k2 = `${f.account ?? "-"}:${h}`;
        const a3 = byHash.get(k2) ?? [];
        a3.push(f);
        byHash.set(k2, a3);
      }
      for (const [k2, harr] of byHash) {
        if (harr.length < 2) continue;
        const hash = k2.split(":")[1];
        const prot = harr.filter((f) => f.zone === "protected");
        const free = harr.filter((f) => f.zone === "dedupe");
        const g: DupGroup = {
          hash, size: harr[0].size, files: harr, remove: [], reportOnly: false, reason: "",
        };
        if (prot.length >= 2) {
          g.reportOnly = true;
          g.reason = "2+ cópias protegidas por app — só relatório";
        } else if (prot.length === 1) {
          g.keep = prot[0];
          g.remove = free;
          g.reason = "mantida a cópia protegida por app";
        } else {
          const { keep, reason } = pickKeep(harr, opts.priorities);
          g.keep = keep;
          g.remove = harr.filter((f) => f !== keep);
          g.reason = reason;
        }
        groups.push(g);
      }
    }
    done++;
    if (done % 50 === 0) opts.onProgress?.(`dedupe: ${done} grupos de tamanho processados`);
  }

  // 4) byte a byte antes de marcar remoção
  for (const g of groups) {
    if (!g.keep || g.reportOnly) continue;
    const verified: DupFile[] = [];
    for (const f of g.remove) {
      try {
        if (await sameBytes(f.path, g.keep.path)) verified.push(f);
      } catch { /* some da lista se não deu p/ comparar */ }
    }
    g.remove = verified;
  }

  await saveIndex(idx);
  groups.sort((a, b) => b.size * b.remove.length - a.size * a.remove.length);
  return { groups, index: idx };
}

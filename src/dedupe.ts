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
      let hashed = 0;
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
        if (++hashed % 2000 === 0) opts.onProgress?.(`dedupe: ${hashed} hashes calculados`);
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
    if (done % 500 === 0) opts.onProgress?.(`dedupe: ${done}/${bySize.size} grupos de tamanho`);
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

  // poda do cache: entradas de arquivos que não apareceram nesta run somem
  const seen = new Set(cand.map((f) => f.path));
  for (const k of Object.keys(idx)) if (!seen.has(k)) delete idx[k];
  await saveIndex(idx);

  groups.sort((a, b) => b.size * b.remove.length - a.size * a.remove.length);
  return { groups, index: idx };
}

export interface DupDir {
  rel: string;
  keep: string;
  files: number;
  size: number;
}

/**
 * Dedupe de PASTAS inteiras: fingerprint = hash da árvore (nome+size+sha de
 * cada arquivo). Duas pastas idênticas viram unidade: verifica byte a byte
 * e marca a pior para sair inteira.
 */
export async function findDuplicateDirs(
  files: { path: string; rel: string; size: number; mtimeMs: number }[],
  hashOf: (path: string) => string | undefined,
  opts: { priorities: string[]; maxVerify?: number },
): Promise<DupDir[]> {
  // monta árvore: dir -> linhas "relpath|size|hash"
  const tree = new Map<string, string[]>();
  const fileOf = new Map<string, DupFile>();
  for (const f of files) {
    const rel = f.rel.toLowerCase();
    const i = rel.lastIndexOf("/");
    if (i < 0) continue;
    const dir = rel.slice(0, i);
    const h = hashOf(f.path) ?? `s${f.size}`;
    const a = tree.get(dir) ?? [];
    a.push(`${rel.slice(i + 1)}|${f.size}|${h}`);
    tree.set(dir, a);
    fileOf.set(rel, f);
  }
  const fp = new Map<string, string[]>();
  for (const [dir, lines] of tree) {
    if (lines.length < 3) continue; // pasta com pouca coisa não compensa
    lines.sort();
    const hash = createHash("sha256").update(lines.join("\n")).digest("hex");
    const a = fp.get(hash) ?? [];
    a.push(dir);
    fp.set(hash, a);
  }
  const out: DupDir[] = [];
  const maxVerify = opts.maxVerify ?? 300;
  for (const dirs of fp.values()) {
    if (dirs.length < 2) continue;
    // só conta que não seja subpasta de outra no mesmo grupo
    const tops = dirs.filter((d) => !dirs.some((o) => o !== d && d.startsWith(o + "/")));
    if (tops.length < 2) continue;
    const dFiles = tops.map((d) => dirs.filter((x) => x === d || x.startsWith(d + "/")));
    const count = dFiles.map((a) => a.length);
    const size = new Map<string, number>();
    for (const d of tops) {
      let s = 0;
      for (const sub of dirs.filter((x) => x === d || x.startsWith(d + "/"))) {
        for (const line of tree.get(sub) ?? []) s += Number(line.split("|")[1]);
      }
      size.set(d, s);
    }
    // escolhe o mantido pela prioridade configurada
    const ranked = [...tops].sort((a, b) => {
      const pa = priorityOf(a, opts.priorities);
      const pb = priorityOf(b, opts.priorities);
      return pa !== pb ? pa - pb : a.length - b.length;
    });
    const keep = ranked[0];
    // verificação byte a byte de TODOS os arquivos pareados
    for (const d of ranked.slice(1)) {
      const members: [string, string][] = [];
      let ok = true, checked = 0, totalSize = 0;
      for (const sub of dirs.filter((x) => x === d || x.startsWith(d + "/"))) {
        for (const line of tree.get(sub) ?? []) {
          const name = line.split("|")[0];
          const relA = `${sub}/${name}`;
          const relB = `${keep}/${relA.slice(d.length + 1)}`;
          members.push([relA, relB]);
          totalSize += Number(line.split("|")[1]);
        }
      }
      if (members.length > maxVerify) continue; // grande demais p/ verificar — não arrisca
      for (const [ra, rb] of members) {
        const fa = fileOf.get(ra);
        const fb = fileOf.get(rb);
        if (!fa || !fb || !(await sameBytes(fa.path, fb.path))) { ok = false; break; }
        checked++;
      }
      if (ok && checked === members.length) {
        out.push({ rel: d, keep, files: count[tops.indexOf(d)] ?? members.length, size: totalSize });
      }
    }
  }
  return out;
}

import { appendFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { TrashEntry } from "./types.ts";
import { CS_HOME, LOG_FILE, TRASH_DIR, nowIso } from "./util.ts";

const MANIFEST = join(TRASH_DIR, "manifest.json");
const RETENTION_MS = 7 * 86_400_000;

export async function log(msg: string): Promise<void> {
  try {
    await mkdir(CS_HOME, { recursive: true });
    // rotação simples do próprio log (5 MB)
    try {
      const st = await stat(LOG_FILE);
      if (st.size > 5 * 1024 * 1024) await rename(LOG_FILE, LOG_FILE + ".1");
    } catch { /* ok */ }
    await appendFile(LOG_FILE, `${nowIso()} ${msg}\n`);
  } catch { /* log nunca quebra o fluxo */ }
}

async function loadManifest(): Promise<TrashEntry[]> {
  try {
    return JSON.parse(await readFile(MANIFEST, "utf8")) as TrashEntry[];
  } catch {
    return [];
  }
}

async function saveManifest(m: TrashEntry[]): Promise<void> {
  await writeFile(MANIFEST, JSON.stringify(m, null, 1));
}

/** Move arquivo/pasta para a lixeira. Retorna o id da entrada. */
export async function toTrash(
  absPath: string,
  meta: { hash?: string; keptOriginal?: string } = {},
): Promise<string | null> {
  const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const dest = join(TRASH_DIR, id);
  try {
    await mkdir(TRASH_DIR, { recursive: true });
    let size = 0;
    let isDir = false;
    try {
      const st = await stat(absPath);
      size = st.size;
      isDir = st.isDirectory();
    } catch { /* some na hora da cópia */ }
    await mkdir(dest, { recursive: true });
    const destPath = join(dest, basename(absPath));
    try {
      await rename(absPath, destPath);
    } catch {
      // fallback cross-device (ex.: /sdcard FAT -> $HOME ext4), funciona p/ pasta tb
      await cp(absPath, destPath, { recursive: true });
      await rm(absPath, { recursive: isDir, force: true });
    }
    if (isDir) size = await dirSize(destPath);
    const m = await loadManifest();
    m.push({
      id, original: absPath, trashedAt: Date.now(), size,
      hash: meta.hash, keptOriginal: meta.keptOriginal,
    });
    await saveManifest(m);
    await log(`trash ${absPath} -> ${id}`);
    return id;
  } catch (err) {
    await log(`ERRO trash ${absPath}: ${String(err)}`);
    return null;
  }
}

export async function listTrash(): Promise<TrashEntry[]> {
  return loadManifest();
}

export async function restore(idOrPath: string): Promise<boolean> {
  const m = await loadManifest();
  const e = m.find((x) => x.id === idOrPath || x.original === idOrPath);
  if (!e) return false;
  const src = join(TRASH_DIR, e.id, basename(e.original));
  try {
    await rename(src, e.original);
  } catch {
    try {
      await mkdir(dirname(e.original), { recursive: true });
      await cp(src, e.original, { recursive: true });
      await rm(src, { recursive: true, force: true });
    } catch {
      return false;
    }
  }
  await saveManifest(m.filter((x) => x !== e));
  try { await rm(join(TRASH_DIR, e.id), { recursive: true, force: true }); } catch { /* ok */ }
  await log(`restore ${e.original}`);
  return true;
}

export async function emptyTrash(): Promise<number> {
  const m = await loadManifest();
  let freed = 0;
  for (const e of m) freed += e.size;
  for (const e of m) {
    try { await rm(join(TRASH_DIR, e.id), { recursive: true, force: true }); } catch { /* ok */ }
  }
  await saveManifest([]);
  await log(`empty-trash ${freed} bytes`);
  return freed;
}

/** Remove entradas com mais de 7 dias. Chamado automaticamente no início de cada run. */
export async function purgeOldTrash(): Promise<number> {
  const m = await loadManifest();
  const cutoff = Date.now() - RETENTION_MS;
  const keep: TrashEntry[] = [];
  let freed = 0;
  for (const e of m) {
    if (e.trashedAt < cutoff) {
      freed += e.size;
      try { await rm(join(TRASH_DIR, e.id), { recursive: true, force: true }); } catch { /* ok */ }
    } else keep.push(e);
  }
  if (keep.length !== m.length) await saveManifest(keep);
  return freed;
}

export async function trashSize(): Promise<number> {
  const m = await loadManifest();
  return m.reduce((a, e) => a + e.size, 0);
}

async function dirSize(dir: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  let total = 0;
  try {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      try {
        if (d.isDirectory()) total += await dirSize(p);
        else total += (await stat(p)).size;
      } catch { /* ok */ }
    }
  } catch { /* ok */ }
  return total;
}

export function shortHash(p: string): string {
  return createHash("sha1").update(p).digest("hex").slice(0, 8);
}

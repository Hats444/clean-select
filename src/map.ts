import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { scan } from "./scanner.ts";
import { normRel } from "./util.ts";

const REF_DIR = join(import.meta.dirname, "..", "reference");
const DIRS = join(REF_DIR, "dirs.txt");
const BIG = join(REF_DIR, "grandes.txt");
const SIZES = join(REF_DIR, "tamanhos.txt");

export async function loadMap(): Promise<string[]> {
  try {
    const txt = await readFile(DIRS, "utf8");
    return txt.split(/\r?\n/).map(normRel).filter(Boolean);
  } catch {
    return [];
  }
}

export async function loadSizes(): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  try {
    for (const line of (await readFile(SIZES, "utf8")).split(/\r?\n/)) {
      const i = line.indexOf("\t");
      if (i > 0) m.set(line.slice(i + 1).trim(), Number(line.slice(0, i)));
    }
  } catch { /* sem arquivo */ }
  return m;
}

/** --refresh-map: regenera dirs.txt (só pastas), grandes.txt (50MB+) e tamanhos.txt. */
export async function refreshMap(root: string): Promise<void> {
  const dirs: string[] = [];
  const big: { size: number; rel: string }[] = [];
  const sizes = new Map<string, number>();
  await scan({
    root,
    onDir: (rel) => dirs.push(rel),
    onFile: (e) => {
      if (e.size >= 50 * 1024 * 1024) big.push({ size: e.size, rel: e.rel });
      const parent = dirname(e.rel).replace(/\\/g, "/");
      sizes.set(parent === "." ? "/" : parent, (sizes.get(parent === "." ? "/" : parent) ?? 0) + e.size);
    },
  });
  dirs.sort();
  big.sort((a, b) => b.size - a.size);
  await mkdir(REF_DIR, { recursive: true });
  const prefix = root.replace(/\\/g, "/").replace(/\/$/, "");
  await writeFile(DIRS, dirs.map((d) => `${prefix}/${d}`).join("\n") + "\n");
  await writeFile(BIG, big.map((b) => `${(b.size / 1048576).toFixed(1)}\t${prefix}/${b.rel}`).join("\n") + "\n");
  await writeFile(
    SIZES,
    [...sizes.entries()].sort((a, b) => b[1] - a[1]).map(([d, s]) => `${s}\t${prefix}/${d}`).join("\n") + "\n",
  );
}

/** --diff-map: pastas novas no disco que não estão no dirs.txt. */
export async function diffMap(root: string): Promise<string[]> {
  const known = new Set(
    (await loadMap()).map((p) => p.replace(/^\/storage\/emulated\/0\/?/, "").toLowerCase()),
  );
  const found: string[] = [];
  // só nível 1-2 para não varrer tudo
  async function walk(rel: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(root, rel || "."), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (!d.isDirectory()) continue;
      const crel = rel ? `${rel}/${d.name}` : d.name;
      if (!known.has(crel.toLowerCase())) found.push(crel);
      if (depth < 2) await walk(crel, depth + 1);
    }
  }
  await walk("", 0);
  return found;
}

import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { FileEntry, ScanStats } from "./types.ts";
import { normRel } from "./util.ts";
import { cfg } from "./config.ts";

export interface ScanOptions {
  root: string;
  concurrency?: number;
  /** nunca tocar arquivos modificados há menos que isso (ms). Default 60s. */
  minFileAgeMs?: number;
  /** true => não desce nessa pasta (recebe rel da pasta e nome) */
  skipDir?: (rel: string, name: string) => boolean;
  /** chamado para cada arquivo elegível */
  onFile: (e: FileEntry) => void;
  /** chamado para cada pasta visitada (inclui as puladas, com flag) */
  onDir?: (rel: string, name: string, skipped: boolean) => void;
}

const MIN_AGE_MS = cfg.minFileAgeSec * 1000;

/**
 * Varredura assíncrona com fs.opendir e concorrência limitada.
 * Não carrega a árvore em memória: cada arquivo é entregue via onFile.
 * Symlinks nunca são seguidos (lstat). EACCES/ENOENT contam em `ignored`.
 */
export async function scan(opts: ScanOptions): Promise<ScanStats> {
  const { root } = opts;
  const conc = opts.concurrency ?? cfg.scanConcurrency;
  const minAge = opts.minFileAgeMs ?? MIN_AGE_MS;
  const now = Date.now();
  const stats: ScanStats = { files: 0, dirs: 0, bytes: 0, ignored: 0 };
  const queue: string[] = [""];
  let inFlight = 0;

  await new Promise<void>((resolve) => {
    const tick = () => {
      while (queue.length > 0 && inFlight < conc) {
        const rel = queue.pop()!;
        inFlight++;
        void handle(rel);
      }
      if (queue.length === 0 && inFlight === 0) resolve();
    };

    const handle = async (rel: string) => {
      try {
        const dir = await opendir(join(root, rel || "."));
        for await (const d of dir) {
          const crel = rel ? `${rel}/${d.name}` : d.name;
          // Dirent já diz tipo: evita um lstat por pasta/symlink (metade das syscalls)
          if (d.isDirectory()) {
            stats.dirs++;
            const skipped = opts.skipDir?.(normRel(crel), d.name) ?? false;
            opts.onDir?.(normRel(crel), d.name, skipped);
            if (!skipped) queue.push(crel);
            continue;
          }
          if (d.isSymbolicLink() || d.isFIFO() || d.isSocket() || d.isCharacterDevice() || d.isBlockDevice()) {
            continue; // nunca seguir
          }
          const abs = join(root, crel);
          let st;
          try {
            st = await lstat(abs);
          } catch {
            stats.ignored++;
            continue;
          }
          if (st.isSymbolicLink()) continue;
          if (st.isFile()) {
            if (now - st.mtimeMs < minAge) continue;
            stats.files++;
            stats.bytes += st.size;
            opts.onFile({ path: abs, rel: normRel(crel), size: st.size, mtimeMs: st.mtimeMs });
          }
        }
      } catch {
        stats.ignored++;
      } finally {
        inFlight--;
        tick();
      }
    };
    tick();
  });

  return stats;
}

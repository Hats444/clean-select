import { join } from "node:path";
import { statfs } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

import { cfg } from "./config.ts";

export const CS_HOME = process.env.CLEAN_SELECT_HOME ?? cfg.home;
export const TRASH_DIR = join(CS_HOME, "trash");
export const LOG_FILE = join(CS_HOME, "log.txt");
export const LOCK_FILE = join(CS_HOME, "lock");
export const HISTORY_FILE = join(CS_HOME, "history.json");
export const HASH_INDEX = join(CS_HOME, "index.json");

export function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** glob -> RegExp. Suporta **, *, ?, {a,b}. Case-insensitive, casa o path relativo com "/". */
export function globToRe(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") { re += "(?:[^/]+/)*"; i += 3; }
        else { re += ".*"; i += 2; }
      } else { re += "[^/]*"; i += 1; }
    } else if (c === "?") { re += "[^/]"; i += 1; }
    else if (c === "{") {
      const j = glob.indexOf("}", i);
      const parts = glob.slice(i + 1, j).split(",").map(escRe);
      re += "(?:" + parts.join("|") + ")";
      i = j + 1;
    } else if (c === "[") {
      const j = glob.indexOf("]", i);
      re += glob.slice(i, j + 1);
      i = j + 1;
    } else { re += escRe(c); i += 1; }
  }
  return new RegExp("^" + re + "$", "i");
}

const reCache = new Map<string, RegExp>();
export function matchGlob(glob: string, rel: string): boolean {
  let re = reCache.get(glob);
  if (!re) { re = globToRe(glob); reCache.set(glob, re); }
  return re.test(rel);
}

export function matchAny(globs: string[], rel: string): boolean {
  return globs.some((g) => matchGlob(g, rel));
}

export function normRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export interface DiskInfo {
  /** bytes livres para apps */
  free: number;
  /** bytes totais do volume */
  total: number;
  /** de onde veio a leitura */
  source: "statfs" | "df" | "none";
}

/**
 * Memória real do celular em tempo real. statfs primeiro; se vier zerado
 * (mounts estranhos/Windows), cai p/ `df -k <path>` (funciona no Termux).
 */
export async function diskInfo(path: string): Promise<DiskInfo> {
  try {
    const s = await statfs(path);
    const free = s.bavail * s.bsize;
    const total = s.blocks * s.bsize;
    // alguns ambientes devolvem blocos/bogus: aceita só se total > 1 MB
    if (Number.isFinite(total) && total > 1024 * 1024) return { free, total, source: "statfs" };
  } catch { /* cai p/ df */ }
  try {
    const { stdout } = await execFileP("df", ["-k", path], { timeout: 8000 });
    const line = stdout.trim().split("\n").pop() ?? "";
    const cols = line.trim().split(/\s+/);
    // df: Filesystem 1K-blocks Used Available Use% Mounted
    const total = Number(cols[1]) * 1024;
    const free = Number(cols[3]) * 1024;
    if (Number.isFinite(total) && total > 0) return { free, total, source: "df" };
  } catch { /* sem df */ }
  return { free: 0, total: 0, source: "none" };
}

/** formata bytes: MB até 1024, depois GB com 1 casa */
export function sizeFmt(bytes: number): string {
  const mbV = bytes / 1048576;
  return mbV >= 1024 ? `${(mbV / 1024).toFixed(1)} GB` : `${mbV.toFixed(1)} MB`;
}

import { homedir } from "node:os";
import { join } from "node:path";

export const CS_HOME = process.env.CLEAN_SELECT_HOME ?? join(homedir(), ".clean_select");
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

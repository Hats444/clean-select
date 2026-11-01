export type Level = "auto" | "confirmar" | "relatorio";

export interface FileEntry {
  /** caminho absoluto */
  path: string;
  /** caminho relativo à raiz, com barras "/" */
  rel: string;
  size: number;
  mtimeMs: number;
}

export interface Rule {
  id: string;
  letter: string;
  level: Level;
  aggressive?: boolean;
  /** globs casados contra o caminho relativo ("/" como separador) */
  patterns: string[];
  /** globs que excluem mesmo se patterns casar */
  exclude?: string[];
  /** idade mínima do arquivo em dias (default: ageDays global) */
  minAgeDays?: number;
  /** aplica ao CONTEÚDO da pasta, mantendo a pasta */
  contentOnly?: boolean;
  description?: string;
}

export interface Rules {
  version: number;
  limits: { maxBytes: number; maxPercent: number };
  dedupePriority: string[];
  dedupeAutoZones: string[];
  backupDirs: string[];
  whatsappMedia: { legacy: string[]; accountMedia: string[] };
  rules: Rule[];
}

export interface Finding {
  path: string;
  rel: string;
  size: number;
  mtimeMs: number;
  ruleId: string;
  letter: string;
  level: Level;
  note?: string;
}

export interface ScanStats {
  files: number;
  dirs: number;
  bytes: number;
  ignored: number;
}

export interface TrashEntry {
  id: string;
  original: string;
  trashedAt: number;
  size: number;
  hash?: string;
  keptOriginal?: string;
}

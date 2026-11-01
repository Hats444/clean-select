import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Configuração central: variável de ambiente > clean-select.env > defaults.
 * Formato KEY=VALOR, # comenta. O daemon relê o arquivo a cada ciclo —
 * edite à vontade que vale na próxima volta, sem reiniciar nada.
 */
const BASE = join(import.meta.dirname, "..");

function loadFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* sem arquivo */ }
  return out;
}

let FILE_ENV: Record<string, string> = {};

function reloadEnvFile(): void {
  FILE_ENV = { ...loadFile(join(BASE, ".env")), ...loadFile(join(BASE, "clean-select.env")) };
}
reloadEnvFile();

function get(key: string, dflt: string): string {
  return process.env[key] ?? FILE_ENV[key] ?? dflt;
}
function num(key: string, dflt: number): number {
  const n = Number(get(key, String(dflt)));
  return Number.isFinite(n) ? n : dflt;
}

export const envFileLoaded = existsSync(join(BASE, "clean-select.env"));

function buildCfg() {
  return {
    // — memória / escalonamento —
    /** livre >= isto = tranquilo */
    freeOkPct: num("CS_FREE_OK_PCT", 20),
    /** livre < isto = emergência */
    freeEmergencyPct: num("CS_FREE_EMERGENCY_PCT", 10),
    /** meta: ele limpa até a memória livre chegar aqui */
    freeTargetPct: num("CS_FREE_TARGET_PCT", 30),

    // — daemon —
    checkMin: num("CS_CHECK_MIN", 30),
    runHours: num("CS_RUN_HOURS", 24),

    // — varredura —
    scanConcurrency: num("CS_SCAN_CONCURRENCY", 16),
    minFileAgeSec: num("CS_MIN_FILE_AGE_SEC", 60),
    ageDays: num("CS_AGE_DAYS", 3),

    // — lixeira / log —
    trashDays: num("CS_TRASH_DAYS", 7),
    /** 1 = em modo emergência a lixeira é esvaziada de vez (libera espaço REAL) */
    trashEmergencyPurge: num("CS_TRASH_EMERGENCY_PURGE", 1),
    logMaxMb: num("CS_LOG_MAX_MB", 5),

    // — dedupe —
    dedupeMinKb: num("CS_DEDUPE_MIN_KB", 4),
    dedupePartialKb: num("CS_DEDUPE_PARTIAL_KB", 64),
    /** 1 = --auto deduplica em TODAS as zonas (só protegido por app fica) */
    dedupeAutoFull: num("CS_DEDUPE_AUTO_FULL", 1),

    // — fusíveis —
    fuseMaxGb: num("CS_FUSE_MAX_GB", 5),
    fuseMaxPct: num("CS_FUSE_MAX_PCT", 20),

    // — relatórios —
    topN: num("CS_TOP_N", 10),
    growthAlertMb: num("CS_GROWTH_ALERT_MB", 500),
    reportFile: get("CS_REPORT_FILE", "/sdcard/Download/clean_select_relatorio.txt"),

    // — paths —
    home: get("CLEAN_SELECT_HOME", join(homedir(), ".clean_select")),
    root: get("CS_ROOT", "/sdcard"),

    // — telegram remoto —
    tgToken: get("CLEAN_SELECT_TG_TOKEN", ""),
    tgChat: get("CLEAN_SELECT_TG_CHAT", ""),
  };
}

export type Cfg = ReturnType<typeof buildCfg>;

export const cfg: Cfg = buildCfg();

/** Relê os arquivos .env e repreenche cfg (o daemon chama a cada ciclo). */
export function reloadCfg(): Cfg {
  reloadEnvFile();
  Object.assign(cfg, buildCfg());
  return cfg;
}

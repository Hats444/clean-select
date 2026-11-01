import { basename } from "node:path";
import type { FileEntry, Finding, Rule, Rules } from "./types.ts";
import { matchAny, matchGlob } from "./util.ts";

/* ================= INTOCÁVEIS (hardcoded, nenhuma regra sobrescreve) ================= */

const STD_DIRS = new Set([
  "alarms", "audiobooks", "dcim", "documents", "download", "movies", "music",
  "notifications", "pictures", "podcasts", "recordings", "ringtones", "android",
]);

const NEVER_NAMES = new Set([
  "session", "sessions", "auth", "creds", "pairing", "zerotwo-qr", "baileys_auth",
  ".git", "database", "databases", "lowdb",
]);

const CODE_DIRS = new Set([
  "src", "commands", "handlers", "core", "services", "utils", "lib", "migrations",
  "scripts", "menu", "views", "dono", "operacao", "javascript", "docs", "tests",
]);

const PAY_DIRS = new Set(["efipay-module", "ohmybruxopay", "pixapi-mercadopago-js"]);

const WA_PROTECTED = new Set([
  "sent", "sticker packs", "whatsapp sticker packs", "profile photos",
  "whatsapp profile photos", "wallpaper", "backups", "databases",
  "quick reply attachments", "premium message media",
  "whatsapp backup excluded stickers",
]);
const WA_PRIVATE_RE = /(^|\/)private$/i;

const NEVER_EXT = new Set([".db", ".sqlite", ".env", ".key", ".pem", ".crt", ".kdbx"]);
const CRED_RE = /credencial|credential|token|secret|senha/i;

function segs(rel: string): string[] {
  return rel.toLowerCase().split("/").filter(Boolean);
}

/**
 * Retorna o motivo de proteção ou null. "wa-private" é proteção branda:
 * a regra F3 [AGR] pode mirar essas pastas; todo o resto é absoluto.
 */
export function protectedReason(rel: string): string | null {
  const s = segs(rel);
  if (s.length === 0) return null;
  const top = s[0];

  // raízes de sistema (quando root="/")
  if (top === "system" || top === "data" || top === "proc" || top === "sys") return "raiz do sistema";

  // pasta padrão do Android (a pasta em si)
  if (s.length === 1 && STD_DIRS.has(top)) return "pasta padrão do Android";

  // mídia pessoal
  if (top === "dcim" && s[1] === "camera") return "DCIM/Camera";
  if (top === "recordings") return "Recordings";
  if (top === "music" && !s.includes(".thumbnails") && !s.includes(".thumbcache")) return "Music";

  // android protegido
  if (top === "android" && s[1] === "obb") return "Android/obb";
  if (top === "android" && s[1] === "media" && s[2] === "com.termux") return "Android/media/com.termux";

  // whatsapp: Media/*/Sent, Private e pastas de sistema do app
  const relL = s.join("/");
  if (relL.includes("whatsapp")) {
    for (const part of s) if (WA_PROTECTED.has(part)) return "WhatsApp protegido";
    if (WA_PRIVATE_RE.test(relL)) return "wa-private";
  }

  let sawNodeModules = false;
  for (let i = 0; i < s.length; i++) {
    const p = s[i];
    if (p === "node_modules") { sawNodeModules = true; continue; }
    if (NEVER_NAMES.has(p)) return `intocável: ${p}`;
    if (PAY_DIRS.has(p)) return "pagamento";
    if (!sawNodeModules && CODE_DIRS.has(p)) return `código: ${p}`;
    if (p === "data" && (s[i + 1] === "users" || s[i + 1] === "product" || s[i + 1] === "system"))
      return `dados: data/${s[i + 1]}`;
    if (s[i - 1] === "users" && s[i - 2] === "data" && p === "config") return "dados: config de usuário";
  }

  const name = s[s.length - 1];
  const dot = name.lastIndexOf(".");
  if (dot > 0 && NEVER_EXT.has(name.slice(dot))) return "arquivo de dados/credencial";
  if (CRED_RE.test(name)) return "credencial/token";

  return null;
}

/* ================= CLASSIFICAÇÃO POR REGRAS (rules.json) ================= */

export interface ClassifyCtx {
  rules: Rules;
  ageDays: number;
  aggressive: boolean;
  only?: Set<string>;
  skip?: Set<string>;
  pruneModules: boolean;
  termux: boolean;
  ignoreGlobs: string[];
}

function ruleEnabled(r: Rule, ctx: ClassifyCtx): boolean {
  const L = r.letter.toUpperCase();
  if (ctx.skip?.has(L)) return false;
  if (ctx.only && !ctx.only.has(L)) return false;
  if (r.aggressive && !ctx.aggressive) return false;
  if (r.id === "A2" && !ctx.pruneModules) return false;
  if (r.id === "H.termux" && !ctx.termux) return false;
  return true;
}

const DAY_MS = 86_400_000;

/**
 * Exceções previstas no spec: F3 mira WhatsApp Private [AGR]; K mira usuários
 * de teste dentro de data/users; A9 limpa locks dentro de .git; D limpa o
 * CONTEÚDO de tmp/cache mesmo quando mora sob database/ ou pasta de código.
 */
function allowsOverride(r: Rule, prot: string, rel: string): boolean {
  if (r.id === "F3" && prot === "wa-private") return true;
  if (r.id === "K" && prot.startsWith("dados")) return true;
  if (r.id === "A9" && prot === "intocável: .git") return true;
  if (r.letter === "D" && prot.startsWith("intocável") && /\/data\/(tmp|edit-videos|media)\b/i.test(rel)) return true;
  if (r.letter === "D" && prot.startsWith("código") && /\b(tmp|temp|cache)\b/i.test(rel)) return true;
  return false;
}

export function classifyFile(e: FileEntry, ctx: ClassifyCtx, now = Date.now()): Finding | null {
  if (matchAny(ctx.ignoreGlobs, e.rel)) return null;
  const prot = protectedReason(e.rel);
  for (const r of ctx.rules.rules) {
    if (!ruleEnabled(r, ctx)) continue;
    if (r.exclude && matchAny(r.exclude, e.rel)) continue;
    if (!matchAny(r.patterns, e.rel)) continue;
    if (prot && !allowsOverride(r, prot, e.rel)) return null;
    const minAge = (r.minAgeDays ?? ctx.ageDays) * DAY_MS;
    if (now - e.mtimeMs < minAge) return null;
    return {
      path: e.path, rel: e.rel, size: e.size, mtimeMs: e.mtimeMs,
      ruleId: r.id, letter: r.letter.toUpperCase(), level: r.level,
    };
  }
  return null;
}

/* ================= PASSES ESTRUTURAIS (pós-scan) ================= */

export interface StructureInfo {
  /** todas as pastas visitadas (rel) */
  dirs: Set<string>;
  /** pastas que contêm pelo menos 1 arquivo */
  filesIn: Set<string>;
  /** arquivos por pasta-pai (só o necessário p/ rotação/apk) */
  filesByDir: Map<string, FileEntry[]>;
  /** dirs node_modules cujo pai tem package.json */
  nodeModulesProjects: { dir: string; parent: string }[];
}

/** B: rotação de backups — mantém os 3 mais novos por pasta. */
export function rotateBackups(info: StructureInfo, backupDirs: string[], ctx: ClassifyCtx): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const [dir, files] of info.filesByDir) {
    const dirL = dir.toLowerCase();
    const isBackup = backupDirs.some((b) => matchGlob(b, dirL)) ||
      /(^|\/)backups?$/.test(dirL) || /(^|\/)backup\//.test(dirL);
    if (!isBackup) continue;
    const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const f of sorted.slice(3)) {
      if (protectedReason(f.rel) || seen.has(f.rel)) continue;
      seen.add(f.rel);
      out.push({ ...f, ruleId: "B", letter: "B", level: "confirmar", note: "rotação: além dos 3 mais recentes" });
    }
  }
  return out;
}

/** A1: node_modules inteiro em projeto com package.json ao lado. */
export function nodeModulesFindings(info: StructureInfo): Finding[] {
  return info.nodeModulesProjects.map(({ dir, parent }) => ({
    path: dir, rel: dir, size: 0, mtimeMs: 0,
    ruleId: "A1", letter: "A", level: "confirmar" as const,
    note: `node_modules regenerável (npm install) em ${parent}`,
  }));
}

/** A4 [relatório]: pacote aninhado duplicado dentro de node_modules. */
export function nestedDupFindings(info: StructureInfo): Finding[] {
  const out: Finding[] = [];
  for (const dir of info.dirs) {
    if (/(^|\/)node_modules\/((@[^/]+\/)?[^/]+)\/node_modules\/\2(\/|$)/i.test(dir)) {
      out.push({
        path: dir, rel: dir, size: 0, mtimeMs: 0,
        ruleId: "A4", letter: "A", level: "relatorio",
        note: "pacote duplicado aninhado — considere `npm dedupe`",
      });
    }
  }
  return out;
}

/** J: pastas vazias (exceto padrão Android e intocáveis). F5: vazias dentro de Media de WhatsApp. */
export function emptyDirFindings(info: StructureInfo): Finding[] {
  const hasContent = new Set<string>();
  const markParents = (d: string) => {
    let i = d.lastIndexOf("/");
    while (i > 0) { hasContent.add(d.slice(0, i)); i = d.lastIndexOf("/", i - 1); }
  };
  for (const d of info.dirs) markParents(d);
  for (const d of info.filesIn) { hasContent.add(d); markParents(d); }
  const empties: string[] = [];
  for (const d of info.dirs) if (!hasContent.has(d) && !protectedReason(d)) empties.push(d);
  // colapsa: só o ancestral mais alto de cada cadeia vazia
  const emptySet = new Set(empties);
  const out: Finding[] = [];
  for (const d of empties) {
    const parent = d.slice(0, d.lastIndexOf("/"));
    if (emptySet.has(parent)) continue;
    const isWaMedia = /whatsapp.*\/media(\/|$)/i.test(d);
    out.push({
      path: d, rel: d, size: 0, mtimeMs: 0,
      ruleId: isWaMedia ? "F5" : "J.empty",
      letter: isWaMedia ? "F" : "J",
      level: isWaMedia ? "auto" : "confirmar",
      note: "pasta vazia",
    });
  }
  return out;
}

/** Zips/rars já extraídos ao lado (mesmo nome-base existe como pasta). */
export function extractedArchiveFindings(files: FileEntry[], info: StructureInfo): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    if (!/\.(zip|rar|7z)$/i.test(f.rel)) continue;
    const stem = f.rel.replace(/\.(zip|rar|7z)$/i, "");
    if (info.dirs.has(stem) && !protectedReason(f.rel)) {
      out.push({ ...f, ruleId: "J.extracted", letter: "J", level: "confirmar", note: "arquivo já extraído ao lado" });
    }
  }
  return out;
}

/** J: backups/apps — manter só a versão mais recente de cada pacote. */
export function appBackupFindings(info: StructureInfo): Finding[] {
  const out: Finding[] = [];
  for (const [dir, files] of info.filesByDir) {
    if (!/(^|\/)backups\/apps$/i.test(dir)) continue;
    const byPkg = new Map<string, FileEntry[]>();
    for (const f of files) {
      const pkg = basename(f.rel).replace(/[-_ ]?v?\d[\d.]*.*\.apk$/i, "").replace(/\.apk$/i, "");
      const arr = byPkg.get(pkg) ?? [];
      arr.push(f);
      byPkg.set(pkg, arr);
    }
    for (const arr of byPkg.values()) {
      const sorted = [...arr].sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const f of sorted.slice(1)) {
        if (!protectedReason(f.rel))
          out.push({ ...f, ruleId: "J.apps", letter: "J", level: "confirmar", note: "versão antiga do mesmo pacote" });
      }
    }
  }
  return out;
}

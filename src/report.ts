import type { Finding, ScanStats } from "./types.ts";
import { mb } from "./util.ts";
import type { DupGroup } from "./dedupe.ts";

export const LETTER_NAMES: Record<string, string> = {
  A: "Node e projetos JS", B: "Backups e snapshots", C: "Espelhos/duplicados",
  D: "Temporários de bots", E: "Logs", F: "WhatsApp", G: "Mídia e thumbnails",
  H: "Apps e sobras", I: "Extensões descartáveis", J: "Downloads e APKs",
  K: "Dados de teste", L: "Só relatório", M: "Duplicados",
};

export function printFindings(findings: Finding[], top = 10): string {
  const byLetter = new Map<string, Finding[]>();
  for (const f of findings) {
    const a = byLetter.get(f.letter) ?? [];
    a.push(f);
    byLetter.set(f.letter, a);
  }
  const lines: string[] = [];
  for (const L of [...byLetter.keys()].sort()) {
    const arr = byLetter.get(L)!;
    const bytes = arr.reduce((a, f) => a + f.size, 0);
    lines.push(`\n== ${L} — ${LETTER_NAMES[L] ?? ""} ==  ${arr.length} itens, ${mb(bytes)} MB`);
    for (const f of [...arr].sort((a, b) => b.size - a.size).slice(0, top)) {
      lines.push(`  [${f.level}] ${mb(f.size).padStart(8)} MB  ${f.rel}${f.note ? `  (${f.note})` : ""}`);
    }
    if (arr.length > top) lines.push(`  ... e mais ${arr.length - top}`);
  }
  return lines.join("\n");
}

export function printDupReport(groups: DupGroup[], top = 20): string {
  const actionable = groups.filter((g) => g.remove.length > 0);
  const freed = actionable.reduce((a, g) => a + g.size * g.remove.length, 0);
  const lines: string[] = [
    `\n== M — Duplicados ==  ${groups.length} grupos, ` +
    `${actionable.reduce((a, g) => a + g.remove.length, 0)} removíveis, ${mb(freed)} MB liberáveis`,
  ];
  for (const g of actionable.slice(0, top)) {
    lines.push(`\n  ${mb(g.size)} MB x${g.files.length}  (${g.reason})`);
    for (const f of g.files) {
      const tag = f === g.keep ? "MANTIDO " : f.zone === "protected" ? "PROTEGIDO" : "remover  ";
      lines.push(`    ${tag} ${f.rel}`);
    }
  }
  const report = groups.filter((g) => g.reportOnly);
  if (report.length) lines.push(`\n  ${report.length} grupos só-relatório (2+ cópias protegidas por app).`);
  return lines.join("\n");
}

export function scanSummary(stats: ScanStats, ms: number): string {
  return `escaneados ${stats.files} arquivos / ${stats.dirs} pastas ` +
    `(${mb(stats.bytes)} MB) em ${(ms / 1000).toFixed(1)}s — ${stats.ignored} ignorados (EACCES/ENOENT)`;
}

export function asciiBar(value: number, max: number, width = 30): string {
  const n = max > 0 ? Math.round((value / max) * width) : 0;
  return "#".repeat(n).padEnd(width, ".");
}

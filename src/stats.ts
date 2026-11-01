import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HISTORY_FILE, mb, nowIso } from "./util.ts";
import { asciiBar } from "./report.ts";
import { trashSize } from "./trash.ts";

export interface HistoryEntry {
  date: string;
  profile: string;
  freedByLetter: Record<string, number>;
  freedTotal: number;
  durationMs: number;
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  try {
    return JSON.parse(await readFile(HISTORY_FILE, "utf8")) as HistoryEntry[];
  } catch {
    return [];
  }
}

export async function recordRun(e: HistoryEntry): Promise<void> {
  const h = await loadHistory();
  h.push(e);
  await mkdir(dirname(HISTORY_FILE), { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(h, null, 1));
}

export async function statsReport(): Promise<string> {
  const h = await loadHistory();
  const lines: string[] = ["== Clean Select — estatísticas =="];
  if (!h.length) lines.push("sem execuções registradas ainda.");
  const total = h.reduce((a, e) => a + e.freedTotal, 0);
  lines.push(`total liberado na vida: ${mb(total)} MB em ${h.length} execuções`);
  const weeks = Math.max(1, h.length ? (Date.now() - new Date(h[0].date).getTime()) / (7 * 864e5) : 1);
  lines.push(`média semanal: ${mb(total / weeks)} MB`);
  const byCat = new Map<string, number>();
  for (const e of h) for (const [k, v] of Object.entries(e.freedByLetter)) {
    byCat.set(k, (byCat.get(k) ?? 0) + v);
  }
  const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
  const max = cats[0]?.[1] ?? 1;
  lines.push("\ncategorias mais pesadas:");
  for (const [k, v] of cats.slice(0, 10)) lines.push(`  ${k.padEnd(3)} ${asciiBar(v, max)} ${mb(v)} MB`);
  lines.push("\ntendência (últimas 12 execuções):");
  const last = h.slice(-12);
  const maxRun = Math.max(1, ...last.map((e) => e.freedTotal));
  for (const e of last) lines.push(`  ${e.date.slice(0, 10)} ${asciiBar(e.freedTotal, maxRun, 20)} ${mb(e.freedTotal)}`);
  lines.push(`\nlixeira: ${mb(await trashSize())} MB`);
  lines.push(`gerado em ${nowIso()}`);
  return lines.join("\n");
}

/** P: alerta de crescimento — pasta que cresceu >500MB em 7 dias (compara com reference/tamanhos.txt anterior). */
export function growthAlerts(oldSizes: Map<string, number>, newSizes: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [dir, size] of newSizes) {
    const old = oldSizes.get(dir);
    if (old !== undefined && size - old > 500 * 1024 * 1024) {
      out.push(`${dir}: +${mb(size - old)} MB em 7 dias`);
    }
  }
  return out;
}

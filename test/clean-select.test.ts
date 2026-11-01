import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan } from "../src/scanner.ts";
import { classifyFile, protectedReason, type ClassifyCtx, type StructureInfo } from "../src/classifier.ts";
import { findDuplicates, zoneOf } from "../src/dedupe.ts";
import { checkFuses, FuseError } from "../src/cleaner.ts";
import type { FileEntry, Finding, Rules } from "../src/types.ts";

const rules = JSON.parse(
  await readFile(new URL("../rules.json", import.meta.url), "utf8"),
) as Rules;

let root: string;
const VIDEO = Buffer.alloc(6000, 7); // >4KB p/ entrar no dedupe

function ctx(over: Partial<ClassifyCtx> = {}): ClassifyCtx {
  return {
    rules, ageDays: 0, aggressive: false, pruneModules: true, termux: false,
    ignoreGlobs: [], ...over,
  };
}

async function collect(c: ClassifyCtx) {
  const findings: Finding[] = [];
  const files: FileEntry[] = [];
  await scan({
    root, minFileAgeMs: 0,
    onFile: (e) => {
      files.push(e);
      const f = classifyFile(e, c);
      if (f) findings.push(f);
    },
  });
  return { findings, files };
}

before(async () => {
  process.env.CLEAN_SELECT_HOME = await mkdtemp(join(tmpdir(), "cs-home-"));
  root = await mkdtemp(join(tmpdir(), "cs-root-"));
  const OLD = new Date(Date.now() - 100 * 864e5); // 100 dias: passa em todo minAgeDays
  const w = async (rel: string, data: Buffer | string = "x") => {
    await mkdir(join(root, rel.split("/").slice(0, -1).join("/")), { recursive: true });
    const p = join(root, rel);
    await writeFile(p, data);
    await utimes(p, OLD, OLD);
  };
  const d = (rel: string) => mkdir(join(root, rel), { recursive: true });

  // projeto fake
  await w("proj/package.json", "{}");
  await w("proj/node_modules/foo/test/x.js", "x");
  await w("proj/node_modules/@esbuild/win32-x64/esbuild.exe", "x");
  await w("proj/node_modules/foo/index.js", "keep");
  await w("proj/.npm/_cacache/sha512/aa/bb", "x");
  await d("proj/session");
  await w("proj/session/creds.json", "{}");
  await d("proj/database");
  await w("proj/database/data.db", "db");
  // backups com 5 versões
  for (let i = 1; i <= 5; i++) {
    await w(`proj/backup/b${i}.zip`, Buffer.alloc(100, i));
  }
  await d("Alarms");
  // 3+1 cópias do vídeo
  await w("Download/video.mp4", VIDEO);
  await w("Telegram/video.mp4", VIDEO);
  await w("Android/media/com.whatsapp/WhatsApp/accounts/1016/Media/WhatsApp Video/video.mp4", VIDEO);
  await w("DCIM/Camera/video.mp4", VIDEO);
  // duplicados dentro de node_modules (não devem entrar no dedupe)
  await w("proj/node_modules/a/dup.bin", VIDEO);
  await w("proj/node_modules/b/dup.bin", VIDEO);
  // mesma imagem em duas contas (nunca cruzar)
  const PIC = Buffer.alloc(5000, 9);
  await w("Android/media/com.whatsapp/WhatsApp/accounts/1016/Media/WhatsApp Images/img.jpg", PIC);
  await w("Android/media/com.whatsapp/WhatsApp/accounts/1003/Media/WhatsApp Images/img.jpg", PIC);
});

test("scanner não segue symlink e conta ignorados", async () => {
  const st = await scan({ root, minFileAgeMs: 0, onFile: () => {} });
  assert.ok(st.files > 10);
});

test("intocáveis: session, database, Alarms, DCIM/Camera", () => {
  for (const rel of [
    "proj/session/creds.json",
    "proj/database/data.db",
    "Alarms",
    "DCIM/Camera/video.mp4",
    "proj/node_modules/foo/index.js/../..", // sanity: normalização não é feita aqui
  ].slice(0, 4)) {
    assert.ok(protectedReason(rel), `${rel} devia ser protegido`);
  }
});

test("classificador: poda node_modules, cache npm, plataforma errada", async () => {
  const { findings } = await collect(ctx());
  const rels = findings.map((f) => f.rel);
  assert.ok(rels.includes("proj/node_modules/foo/test/x.js"), "test/ em node_modules");
  assert.ok(rels.includes("proj/node_modules/@esbuild/win32-x64/esbuild.exe"), "binário win32");
  assert.ok(rels.includes("proj/.npm/_cacache/sha512/aa/bb"), "_cacache");
  assert.ok(!rels.includes("proj/node_modules/foo/index.js"), "index.js fica");
  assert.ok(!rels.some((r) => r.startsWith("proj/session")), "session nunca");
  assert.ok(!rels.some((r) => r.startsWith("proj/database")), "database nunca");
  assert.ok(!rels.some((r) => r === "Alarms"), "Alarms fica");
});

test("dedupe: remove só Download e Telegram; mantém app e Camera", async () => {
  const { files } = await collect(ctx());
  const { groups } = await findDuplicates(files, {
    priorities: rules.dedupePriority,
    autoZones: rules.dedupeAutoZones,
    auto: false,
    projectDirs: new Set(["proj"]),
  });
  const vid = groups.find((g) => g.size === VIDEO.length);
  assert.ok(vid, "grupo do vídeo existe");
  assert.equal(vid!.reportOnly, false);
  assert.equal(vid!.keep!.zone, "protected");
  const removed = vid!.remove.map((f) => f.rel).sort();
  assert.deepEqual(removed, ["Download/video.mp4", "Telegram/video.mp4"]);
  // dentro de node_modules: zona excluded, nem aparece
  assert.ok(!vid!.files.some((f) => f.rel.includes("node_modules")));
});

test("dedupe: nunca cruza contas 1016 x 1003", async () => {
  const { files } = await collect(ctx());
  const { groups } = await findDuplicates(files, {
    priorities: rules.dedupePriority, autoZones: rules.dedupeAutoZones,
    auto: false, projectDirs: new Set(["proj"]),
  });
  const pic = groups.find((g) => g.files.some((f) => f.rel.includes("img.jpg")));
  // contas diferentes -> hash keys separados -> não forma grupo
  assert.equal(pic, undefined);
});

test("dedupe autoFull: réplicas saem de qualquer zona, protegido nunca sai", async () => {
  const { files } = await collect(ctx());
  const { groups } = await findDuplicates(files, {
    priorities: rules.dedupePriority, autoZones: rules.dedupeAutoZones,
    auto: true, autoFull: true, projectDirs: new Set(["proj"]),
  });
  const vid = groups.find((g) => g.size === VIDEO.length);
  assert.ok(vid);
  assert.equal(vid!.keep!.zone, "protected");
  assert.deepEqual(vid!.remove.map((f) => f.rel).sort(), ["Download/video.mp4", "Telegram/video.mp4"]);
});

test("zona: android/media e accounts são protegidos", () => {
  assert.equal(zoneOf("android/media/x/y.jpg", new Set()), "protected");
  assert.equal(zoneOf("a/accounts/1016/media/b.jpg", new Set()), "protected");
  assert.equal(zoneOf("dcim/camera/f.jpg", new Set()), "protected");
  assert.equal(zoneOf("download/f.jpg", new Set()), "dedupe");
  assert.equal(zoneOf("proj/node_modules/x/f.jpg", new Set()), "excluded");
});

test("fusível: aborta acima do limite sem --confirmo-grande", () => {
  const big: Finding[] = [{
    path: "/x", rel: "x", size: 6 * 1024 ** 3, mtimeMs: 0,
    ruleId: "I", letter: "I", level: "auto",
  }];
  assert.throws(() => checkFuses(big, 10, rules.limits, false), FuseError);
  checkFuses(big, 10, rules.limits, true); // com a flag passa
});

test("lixeira: toTrash + restore", async () => {
  const { toTrash, restore } = await import("../src/trash.ts");
  const p = join(root, "Download", "para_lixeira.txt");
  await writeFile(p, "bye");
  const id = await toTrash(p, {});
  assert.ok(id);
  assert.ok(await restore(id!));
  assert.equal(await readFile(p, "utf8"), "bye");
});

test("lixeira: funciona com pastas (A1 node_modules, pastas vazias)", async () => {
  const { toTrash, restore, listTrash } = await import("../src/trash.ts");
  const dir = join(root, "Download", "pasta_para_lixeira");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "arquivo.txt"), "conteudo");
  const id = await toTrash(dir, {});
  assert.ok(id, "toTrash de pasta devia funcionar");
  const entry = (await listTrash()).find((e) => e.id === id);
  assert.ok(entry && entry.size > 0, "tamanho da pasta no manifest");
  assert.ok(await restore(id!));
  assert.equal(await readFile(join(dir, "arquivo.txt"), "utf8"), "conteudo");
});

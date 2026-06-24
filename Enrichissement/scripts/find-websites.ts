/**
 * Complète la colonne « Website » d'un CSV d'entreprises en DEVINANT le domaine :
 * pour chaque nom, on essaie nom.fr / nom.com (et, pour les noms à plusieurs
 * mots, mots collés / avec tiret / les deux premiers mots), on vérifie que le
 * domaine résout (DNS) ET que la page d'accueil mentionne bien l'entreprise.
 * C'est la passe « gratuite » : elle couvre une grosse partie sans recherche web.
 *
 *   npx tsx scripts/find-websites.ts [chemin.csv] [--limit N] [--concurrency N]
 *
 * Lit data/Company.csv par défaut, écrit à côté un fichier « *-websites.csv »
 * (l'original n'est jamais modifié). Reprend là où il s'est arrêté : un Website
 * déjà rempli est laissé tel quel.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { duckduckgoDomain, guessDomain, searchDomain } from "../src/services/b2b/domain.js";
import { csvCell, parseCsv } from "./csv.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DATA_DIR = fileURLToPath(new URL("../data", import.meta.url));

function arg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  const n = i >= 0 ? parseInt(process.argv[i + 1], 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function argStr(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const input = process.argv[2] && !process.argv[2].startsWith("--")
    ? path.resolve(process.argv[2])
    : path.join(DATA_DIR, "Company.csv");
  const limit = arg("--limit", Infinity);
  // Modes « recherche » pour les noms sans domaine devinable :
  //  --serper : via l'API Serper/Google (fiable, consomme du quota) — recommandé ;
  //  --ddg    : scraping DuckDuckGo (gratuit mais faible rendement, bloque vite).
  const ddg = process.argv.includes("--ddg");
  const serper = process.argv.includes("--serper");
  const concurrency = arg("--concurrency", serper ? 5 : ddg ? 4 : 24);
  const tlds = (argStr("--tlds") ?? "fr,com").split(",").map((s) => s.trim()).filter(Boolean);
  const timeoutMs = arg("--timeout", 8000);

  const records = parseCsv(fs.readFileSync(input, "utf8"));
  if (!records.length) throw new Error("CSV vide");
  const header = records[0];
  const nameIdx = header.findIndex((h) => h.trim().toLowerCase() === "name");
  const siteIdx = header.findIndex((h) => h.trim().toLowerCase() === "website");
  const locIdx = header.findIndex((h) => h.trim().toLowerCase() === "location");
  if (nameIdx < 0 || siteIdx < 0) throw new Error(`Colonnes « Name » et « Website » introuvables : ${header.join(" | ")}`);
  const rows = records.slice(1).filter((r) => r.length > nameIdx && r[nameIdx].trim());

  // Cibles : entreprises sans Website déjà rempli.
  const targets: number[] = [];
  for (let i = 0; i < rows.length && targets.length < limit; i++) {
    if (!(rows[i][siteIdx] ?? "").trim()) targets.push(i);
  }

  const outPath = argStr("--out") ?? input.replace(/\.csv$/i, "") + "-websites.csv";
  const save = () => fs.writeFileSync(outPath, [header, ...rows].map((r) => r.map(csvCell).join(";")).join("\r\n"));

  const t0 = Date.now();
  let done = 0;
  let found = 0;
  let miss = 0; // misses consécutifs (détection de blocage DDG)
  let blocked = false;
  const MISS_LIMIT = 60; // au-delà : DDG bloque probablement → on s'arrête proprement
  const mode = serper ? "recherche Serper" : ddg ? "scraping DuckDuckGo" : "TLD " + tlds.join("/");
  console.error(`${rows.length} entreprises · ${targets.length} à compléter · ${mode} · concurrence ${concurrency}\n`);

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (let k = cursor++; k < targets.length && !blocked; k = cursor++) {
      const row = rows[targets[k]];
      const name = row[nameIdx].trim();
      const city = (locIdx >= 0 ? (row[locIdx] ?? "").split(",")[0].trim() : "") || null;
      let res = null;
      if (serper) {
        // 429/cooldown → on patiente et on RÉESSAIE la même entreprise (jusqu'à
        // ~30 s), au lieu de la perdre. « Aucun résultat » n'est pas réessayé.
        for (let attempt = 0; attempt < 6; attempt++) {
          try { res = await searchDomain([name], city); break; }
          catch { await sleep(5000); }
        }
      } else if (ddg) {
        await sleep(150 + Math.random() * 350); // délai poli (anti-blocage)
        res = await duckduckgoDomain([name], city).catch(() => null);
      } else {
        res = await guessDomain([name], { tlds, timeoutMs }).catch(() => null);
      }
      if (res) {
        while (row.length <= siteIdx) row.push(""); // sécurité si ligne courte
        row[siteIdx] = res.domain;
        found++;
        miss = 0;
      } else if (ddg && ++miss >= MISS_LIMIT) {
        blocked = true; // trop d'échecs d'affilée : DDG nous a probablement coupés
      }
      done++;
      if (done % 25 === 0 || done === targets.length) {
        const rate = done / ((Date.now() - t0) / 1000);
        const eta = Math.round((targets.length - done) / Math.max(rate, 0.1));
        process.stderr.write(`\r  ${done}/${targets.length} traitées · ${found} sites · ~${eta}s restantes   `);
      }
      if (done % 100 === 0) save(); // checkpoint : reprise possible si interrompu
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  save();
  if (blocked) console.error("\n⚠️  Arrêt anticipé : trop d'échecs consécutifs (blocage DuckDuckGo ou quota Serper épuisé). Progrès sauvegardé — relancer plus tard reprendra le reste.");

  const pct = targets.length ? Math.round((found / targets.length) * 100) : 0;
  console.error(`\n\n✓ ${found}/${targets.length} sites trouvés (${pct} %) en ${Math.round((Date.now() - t0) / 1000)}s`);
  console.error(`→ ${outPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});

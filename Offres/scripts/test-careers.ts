/**
 * Banc d'essai de detectCareers sur un échantillon d'entreprises de la base
 * Enrichissement (ouverte en LECTURE SEULE). N'écrit rien nulle part.
 *
 *   npx tsx scripts/test-careers.ts [N] [graine]      échantillon de N entreprises (60 par défaut)
 *   npx tsx scripts/test-careers.ts exemple.com …     domaines donnés, résultat détaillé
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { parseBoardRef } from "../src/ats.js";
import { isInFrance, techCategory } from "../src/classify.js";
import { atsNameOfUrl, detectCareers, type CareersResult } from "../src/sources/careers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(here, "../../Enrichissement/data/enrichissement.db");
const CONCURRENCY = 6;

const args = process.argv.slice(2);
const explicit = args.filter((a) => /[a-z]\.[a-z]{2,}/i.test(a));
const n = Number(args.find((a) => /^\d+$/.test(a))) || 60;
const seed = Number(args.filter((a) => /^\d+$/.test(a))[1]) || 1;

interface Company {
  name: string;
  domain: string;
  headcount: number | null;
  industry: string | null;
}

function sample(): Company[] {
  if (explicit.length) return explicit.map((d) => ({ name: d, domain: d, headcount: null, industry: null }));
  const FILTER =
    "industry IN ('Software Development', 'Technology, Information and Internet') AND headcount BETWEEN 10 AND 2000 AND domain IS NOT NULL AND domain != ''";
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM companies WHERE ${FILTER}`).get() as { c: number }).c;
  // ordre pseudo-aléatoire mais reproductible (même graine → même échantillon)
  const rows = db
    .prepare(`SELECT name, domain, headcount, industry FROM companies WHERE ${FILTER} ORDER BY (id * 7919 + ? * 104729) % 10007, id LIMIT ?`)
    .all(seed, n) as Company[];
  db.close();
  console.log(`Filtre : ${FILTER}`);
  console.log(`→ ${total} entreprises éligibles, échantillon de ${rows.length} (graine ${seed})\n`);
  return rows;
}

const pct = (k: number, total: number): string => `${k}/${total} (${total ? Math.round((100 * k) / total) : 0} %)`;

const companies = sample();
const results: Array<{ c: Company; r: CareersResult; ms: number }> = [];
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < companies.length) {
      const c = companies[next++];
      const t0 = Date.now();
      const r = await detectCareers(c.domain);
      const ms = Date.now() - t0;
      results.push({ c, r, ms });

      const hosts = new Map<string, number>();
      for (const u of r.atsUrls) {
        const name = atsNameOfUrl(u) ?? "?";
        hosts.set(name, (hosts.get(name) ?? 0) + 1);
      }
      const refs = new Set(r.atsUrls.map((u) => parseBoardRef(u)).filter(Boolean).map((b) => `${b!.ats}:${b!.slug}`));
      const kept = r.postings.filter((p) => isInFrance(p.location, p.country) && techCategory(p.title, p.department)).length;
      console.log(
        [
          r.domain.padEnd(28),
          `carrières=${r.careersUrl ?? "—"}`,
          `ats=${r.atsUrls.length}${hosts.size ? ` [${[...hosts].map(([h, k]) => `${h}×${k}`).join(", ")}]` : ""}`,
          `boardRef=${refs.size}${refs.size ? ` (${[...refs].join(", ")})` : ""}`,
          `jsonld=${r.postings.length}`,
          `liens-offre=${r.jobLinks.length}`,
          r.platform ? `moteur=${r.platform}` : "",
          `tech-FR=${kept}`,
          `${(ms / 1000).toFixed(1)}s`,
          r.error ? `ERREUR: ${r.error}` : "",
        ]
          .filter(Boolean)
          .join(" | ")
      );
      if (explicit.length) {
        for (const u of r.atsUrls) console.log(`    ats  ${u}`);
        for (const l of r.jobLinks) console.log(`    lien ${l.title} | ${l.url}`);
        for (const p of r.postings) console.log(`    job  ${p.title} | ${p.location ?? "?"} | ${p.country ?? "?"} | ${p.url}`);
      }
    }
  })
);

// ── Synthèse ──────────────────────────────────────────────────────────────────
const total = results.length;
const withCareers = results.filter((x) => x.r.careersUrl).length;
const withAts = results.filter((x) => x.r.atsUrls.length).length;
const withRef = results.filter((x) => x.r.atsUrls.some((u) => parseBoardRef(u))).length;
const withLd = results.filter((x) => x.r.postings.length).length;
const withKept = results.filter((x) => x.r.postings.some((p) => isInFrance(p.location, p.country) && techCategory(p.title, p.department))).length;
const withAny = results.filter((x) => x.r.atsUrls.length || x.r.postings.length).length;
const nothing = results.filter((x) => !x.r.careersUrl && !x.r.atsUrls.length && !x.r.postings.length).length;
const errors = results.filter((x) => x.r.error);

const byAts = new Map<string, number>(); // nombre de domaines par ATS
for (const { r } of results) {
  for (const name of new Set(r.atsUrls.map((u) => atsNameOfUrl(u) ?? "?"))) byAts.set(name, (byAts.get(name) ?? 0) + 1);
}
const byError = new Map<string, number>();
for (const { r } of errors) byError.set(r.error!, (byError.get(r.error!) ?? 0) + 1);
const times = results.map((x) => x.ms).sort((a, b) => a - b);

console.log("\n──────── Synthèse ────────");
console.log(`Domaines testés                         : ${total}`);
console.log(`Page carrières trouvée                  : ${pct(withCareers, total)}`);
console.log(`ATS reconnu (≥ 1 URL)                   : ${pct(withAts, total)}`);
console.log(`  dont lisible par parseBoardRef        : ${pct(withRef, total)}`);
console.log(`Offres JSON-LD sur le site              : ${pct(withLd, total)}`);
console.log(`  dont ≥ 1 offre tech en France         : ${pct(withKept, total)}`);
console.log(`Liens d'offre en HTML (signal faible)   : ${pct(results.filter((x) => x.r.jobLinks.length).length, total)}`);
console.log(`  dont sans ATS ni JSON-LD              : ${pct(results.filter((x) => x.r.jobLinks.length && !x.r.atsUrls.length && !x.r.postings.length).length, total)}`);
const byPlatform = new Map<string, number>();
for (const { r } of results) if (r.platform) byPlatform.set(r.platform, (byPlatform.get(r.platform) ?? 0) + 1);
console.log(`Moteur de la page carrières             : ${[...byPlatform].map(([k, v]) => `${k} ${v}`).join(", ") || "—"}`);
console.log(`ATS ou JSON-LD (source exploitable)     : ${pct(withAny, total)}`);
console.log(`Page carrières sans ATS ni JSON-LD      : ${pct(results.filter((x) => x.r.careersUrl && !x.r.atsUrls.length && !x.r.postings.length).length, total)}`);
console.log(`Rien du tout                            : ${pct(nothing, total)}`);
console.log(`Erreurs                                 : ${pct(errors.length, total)}`);
for (const [e, k] of [...byError].sort((a, b) => b[1] - a[1])) console.log(`    ${k} × ${e}`);
console.log("Domaines par ATS :");
for (const [name, k] of [...byAts].sort((a, b) => b[1] - a[1])) console.log(`    ${name.padEnd(20)} ${k}`);
if (total) {
  console.log(
    `Durée par domaine : médiane ${(times[Math.floor(total / 2)] / 1000).toFixed(1)} s, p90 ${(times[Math.floor(total * 0.9)] / 1000).toFixed(1)} s, max ${(times[total - 1] / 1000).toFixed(1)} s`
  );
}

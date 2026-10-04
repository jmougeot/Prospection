/**
 * Essai de la source Welcome to the Jungle : un seul passage, petit plafond.
 *   npx tsx scripts/test-wttj.ts [maxRequests]
 * N'écrit rien en base.
 */
import { fetchWttjJobs } from "../src/sources/wttj.js";
import { isInFrance, techCategory } from "../src/classify.js";

const maxRequests = Number(process.argv[2]) || 60;
const started = Date.now();
const { postings, requests, error } = await fetchWttjJobs({ maxRequests });

const passing = postings.filter((p) => isInFrance(p.location, p.country) && techCategory(p.title, p.department));
const companies = new Set(postings.map((p) => p.company ?? "?"));
const withText = postings.filter((p) => p.description).length;

console.log(`requêtes        : ${requests} / ${maxRequests} (${Math.round((Date.now() - started) / 1000)} s)`);
console.log(`offres          : ${postings.length} (dont ${withText} avec description)`);
console.log(`France + tech   : ${passing.length}`);
console.log(`entreprises     : ${companies.size}`);
console.log(`erreur          : ${error ?? "aucune"}`);
console.log("");
for (const p of postings.slice(0, 15)) {
  const day = p.posted_at ? new Date(p.posted_at).toISOString().slice(0, 10) : "????-??-??";
  const cat = techCategory(p.title, p.department) ?? "-";
  console.log(`${day}  [${cat}] ${p.company} — ${p.title} (${p.location ?? "?"}${p.remote ? ", télétravail" : ""})`);
  console.log(`            ${p.department ?? "-"} | ${p.external_id}`);
  console.log(`            ${p.url}`);
}
const sample = postings.find((p) => p.description);
if (sample) console.log(`\nExtrait de description (${sample.external_id}) :\n${sample.description!.slice(0, 300)}…`);

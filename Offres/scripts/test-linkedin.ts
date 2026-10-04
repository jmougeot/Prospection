/**
 * Essai de la source LinkedIn (recherche publique, sans compte) : petit plafond.
 *   npx tsx scripts/test-linkedin.ts [maxRequests]
 * N'écrit rien en base.
 */
import { fetchLinkedinJobs } from "../src/sources/linkedin.js";
import { looksLikeAgency } from "../src/sources/aggregators.js";
import { isInFrance, techCategory } from "../src/classify.js";

const maxRequests = Number(process.argv[2]) || 12;
const { postings, requests, error } = await fetchLinkedinJobs({ maxRequests });
const passing = postings.filter((p) => isInFrance(p.location, p.country) && techCategory(p.title, p.department));

console.log(`requêtes        : ${requests} / ${maxRequests}`);
console.log(`offres          : ${postings.length}`);
console.log(`France + tech   : ${passing.length}`);
console.log(`cabinets / ESN  : ${passing.filter((p) => looksLikeAgency(p)).length}`);
console.log(`entreprises     : ${new Set(passing.map((p) => p.company)).size}`);
console.log(`erreur          : ${error ?? "aucune"}\n`);
for (const p of passing.slice(0, 15)) {
  console.log(`${p.posted_at ? new Date(p.posted_at).toISOString().slice(0, 10) : "?"}  ${p.company} — ${p.title} (${p.location})${looksLikeAgency(p) ? "  [cabinet/ESN ?]" : ""}`);
}

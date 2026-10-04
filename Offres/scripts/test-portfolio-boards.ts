/**
 * Essai en direct des job boards « portfolio » : pour chaque board vérifié, lit
 * les offres France avec un plafond d'appels modeste et affiche ce que
 * l'intégration pourra en tirer (offres tech France, startups, part des URL
 * d'offres reconnues par `parseBoardRef`, hôtes non reconnus les plus fréquents).
 *
 *   npx tsx scripts/test-portfolio-boards.ts [plafond] [clé,clé…]
 *
 * N'écrit rien (ni base, ni fichier).
 */
import { parseBoardRef } from "../src/ats.js";
import { isInFrance, techCategory } from "../src/classify.js";
import { PORTFOLIO_BOARDS, readPortfolioBoard } from "../src/sources/portfolio-boards.js";

const maxRequests = Number(process.argv[2]) || 6;
const only = (process.argv[3] ?? "").split(",").filter(Boolean);
const boards = only.length ? PORTFOLIO_BOARDS.filter((b) => only.includes(b.key)) : PORTFOLIO_BOARDS;

const host = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "(url invalide)";
  }
};
const top = (counts: Map<string, number>, n: number): string =>
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ") || "—";
const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);

const total = { requests: 0, postings: 0, franceTech: 0, urls: 0, resolved: 0 };
const allAts = new Map<string, number>();
const allUnresolved = new Map<string, number>();
const allSlugs = new Set<string>(); // pages carrières distinctes, tous boards confondus
const allCompanies = new Set<string>();

for (const board of boards) {
  const r = await readPortfolioBoard(board, maxRequests);
  const france = r.postings.filter((p) => isInFrance(p.location, p.country));
  const franceTech = france.filter((p) => techCategory(p.title, p.department));

  const byAts = new Map<string, number>();
  const unresolved = new Map<string, number>();
  const slugs = new Set<string>();
  let urls = 0;
  let resolved = 0;
  for (const c of r.companies) {
    allCompanies.add(c.name.toLowerCase());
    for (const u of c.jobUrls) {
      urls++;
      const ref = parseBoardRef(u);
      if (ref) {
        resolved++;
        bump(byAts, ref.ats);
        bump(allAts, ref.ats);
        slugs.add(`${ref.ats}:${ref.slug}`);
        allSlugs.add(`${ref.ats}:${ref.slug}`);
      } else {
        bump(unresolved, host(u));
        bump(allUnresolved, host(u));
      }
    }
  }
  total.requests += r.requests;
  total.postings += r.postings.length;
  total.franceTech += franceTech.length;
  total.urls += urls;
  total.resolved += resolved;

  const withDomain = r.companies.filter((c) => c.domain).length;
  const withJobs = r.companies.filter((c) => c.jobUrls.length).length;
  console.log(`\n■ ${board.name} [${board.key}] — ${board.platform} — ${board.url}`);
  console.log(`  appels ${r.requests}/${maxRequests}${r.error ? ` · ERREUR : ${r.error}` : ""}`);
  console.log(`  offres ${r.postings.length} · en France ${france.length} · France + tech ${franceTech.length}`);
  console.log(`  startups ${r.companies.length} (avec offre ${withJobs}, avec domaine ${withDomain})`);
  console.log(`  URL d'offres ${urls} · reconnues par parseBoardRef ${resolved} (${urls ? Math.round((100 * resolved) / urls) : 0} %) → ${slugs.size} pages carrières · ${top(byAts, 5)}`);
  console.log(`  hôtes non reconnus : ${top(unresolved, 6)}`);
  for (const p of franceTech.slice(0, 3)) {
    console.log(`    · ${p.company} — ${p.title} — ${p.location ?? "?"} — ${p.url.slice(0, 90)}`);
  }
}

console.log(`\n══ Total (${boards.length} boards, plafond ${maxRequests} appels chacun)`);
console.log(`  appels ${total.requests} · offres ${total.postings} · France + tech ${total.franceTech} · startups distinctes ${allCompanies.size}`);
console.log(`  URL d'offres ${total.urls} · reconnues ${total.resolved} (${total.urls ? Math.round((100 * total.resolved) / total.urls) : 0} %) → ${allSlugs.size} pages carrières distinctes`);
console.log(`  par ATS : ${top(allAts, 5)}`);
console.log(`  hôtes non reconnus : ${top(allUnresolved, 15)}`);

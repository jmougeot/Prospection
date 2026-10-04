/**
 * Découverte de pages carrières : requêtes « site:<ats> <ville> <mot-clé> » sur
 * l'API de recherche (Serper), dont on ne garde que le slug d'entreprise lu dans
 * l'URL de chaque résultat. Les pages déjà payées sont en cache : relancer la
 * découverte rejoue le cache gratuitement et ne dépense que pour aller plus loin.
 */
import { config } from "./config.js";
import { db } from "./db.js";
import { type Ats, parseBoardRef } from "./ats.js";

export function hasSearchApi(): boolean {
  return Boolean(config.serperApiKey);
}

const cacheGet = db.prepare("SELECT urls FROM search_cache WHERE query = ? AND page = ?");
const cachePut = db.prepare("INSERT OR REPLACE INTO search_cache (query, page, urls, fetched_at) VALUES (?, ?, ?, ?)");

async function serper(query: string, page: number): Promise<string[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": config.serperApiKey, "content-type": "application/json" },
    body: JSON.stringify({ q: query, num: 10, page: page + 1, gl: "fr", hl: "fr" }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Serper ${res.status}: ${(await res.text()).slice(0, 80)}`);
  const data = (await res.json()) as { organic?: Array<{ link: string }> };
  return (data.organic ?? []).map((r) => r.link);
}

const SITES = [
  "jobs.lever.co",
  "jobs.ashbyhq.com",
  "job-boards.greenhouse.io",
  "boards.greenhouse.io",
  "jobs.smartrecruiters.com",
  "apply.workable.com",
];
const PLACES = ["Paris", "France", "Lyon", "Nantes", "Toulouse", "Bordeaux", "Lille"];
const KEYWORDS = ["software engineer", "développeur", "data engineer", "machine learning", "devops", "backend"];
const PAGES = 3;

// Mot-clé puis lieu en boucles externes : même un petit budget touche tous les ATS.
function* queries(): Generator<string> {
  for (const kw of KEYWORDS) for (const place of PLACES) for (const site of SITES) yield `site:${site} ${place} ${kw}`;
}

export interface DiscoverProgress {
  paid: number; // appels réellement facturés pendant cette découverte
  found: Array<{ ats: Ats; slug: string }>;
}

/**
 * Parcourt les requêtes de découverte. `budget` plafonne les appels PAYÉS (les
 * pages en cache ne comptent pas) ; `onBoard` est appelé pour chaque page
 * carrières reconnue ; `shouldStop` permet d'interrompre.
 */
export async function discoverBoards(
  budget: number,
  onBoard: (ref: { ats: Ats; slug: string }) => void,
  shouldStop: () => boolean,
  onProgress: (paid: number, query: string) => void
): Promise<void> {
  let paid = 0;
  for (const query of queries()) {
    for (let page = 0; page < PAGES; page++) {
      if (shouldStop()) return;
      let urls: string[];
      const hit = cacheGet.get(query, page) as { urls: string } | undefined;
      if (hit) urls = JSON.parse(hit.urls) as string[];
      else {
        if (paid >= budget) return;
        onProgress(paid, query);
        urls = await serper(query, page); // une erreur (quota, clé) interrompt la découverte
        paid++;
        cachePut.run(query, page, JSON.stringify(urls), Date.now());
      }
      for (const url of urls) {
        const ref = parseBoardRef(url);
        if (ref) onBoard(ref);
      }
      if (urls.length < 8) break; // dernière page de résultats
    }
  }
}

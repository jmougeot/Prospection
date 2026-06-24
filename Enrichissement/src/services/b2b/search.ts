/**
 * Provider de recherche web pour la prospection. Si une clé d'API est
 * configurée (.env), on l'utilise — c'est fiable, légal et propre (titres JSON
 * exploitables). Sinon, le module renvoie null et l'appelant retombe sur le
 * scraping de moteurs publics. Priorité : Google CSE > Serper > Brave, avec
 * bascule au provider suivant si l'un échoue (quota épuisé, erreur réseau…).
 */
import { config } from "../../config.js";
import { db } from "../../db.js";

export interface WebResult {
  url: string;
  title: string;
  snippet: string;
}

// Cache persistant des pages API : une page déjà payée ne reconsomme jamais de
// crédit — relancer la même recherche rejoue le cache (gratuit, instantané) et
// ne dépense qu'au-delà. Aucune expiration automatique : ces résultats sont
// payés, on ne les supprime jamais tout seuls (purge manuelle uniquement, ex.
// DELETE FROM search_cache via sqlite si besoin).
const cacheGet = db.prepare("SELECT results FROM search_cache WHERE query = ? AND page = ?");
const cachePut = db.prepare("INSERT OR REPLACE INTO search_cache (query, page, results, fetched_at) VALUES (?, ?, ?, ?)");

export function hasSearchApi(): boolean {
  const s = config.search;
  return Boolean((s.googleApiKey && s.googleCx) || s.serperApiKey || s.braveApiKey);
}

const TIMEOUT = 10000;

async function googleSearch(query: string, page: number): Promise<WebResult[]> {
  const { googleApiKey, googleCx } = config.search;
  const url = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCx}&q=${encodeURIComponent(
    query
  )}&num=10&start=${1 + page * 10}&hl=fr&gl=fr`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`Google CSE ${res.status}`);
  const data = (await res.json()) as { items?: Array<{ link: string; title: string; snippet?: string }> };
  return (data.items ?? []).map((i) => ({ url: i.link, title: i.title ?? "", snippet: i.snippet ?? "" }));
}

async function serperSearch(query: string, page: number): Promise<WebResult[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": config.search.serperApiKey, "content-type": "application/json" },
    body: JSON.stringify({ q: query, gl: "fr", hl: "fr", num: 10, page: page + 1 }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) {
    const body = await res.text();
    // 400 « bad request » dû à UNE requête (nom bizarre) → « aucun résultat » sans
    // quarantaine. Mais « Not enough credits » (quota épuisé) ou 401/403 = problème
    // de provider : on remonte l'erreur (surtout PAS mettre du vide en cache).
    if (res.status === 400 && !/credit/i.test(body)) return [];
    throw new Error(`Serper ${res.status}: ${body.slice(0, 80)}`);
  }
  const data = (await res.json()) as { organic?: Array<{ link: string; title: string; snippet?: string }> };
  return (data.organic ?? []).map((i) => ({ url: i.link, title: i.title ?? "", snippet: i.snippet ?? "" }));
}

async function braveSearch(query: string, page: number): Promise<WebResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&country=fr&search_lang=fr&count=20&offset=${page}`;
  const res = await fetch(url, {
    headers: { "X-Subscription-Token": config.search.braveApiKey, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`Brave ${res.status}`);
  const data = (await res.json()) as { web?: { results?: Array<{ url: string; title: string; description?: string }> } };
  return (data.web?.results ?? []).map((i) => ({ url: i.url, title: i.title ?? "", snippet: i.description ?? "" }));
}

// Provider en panne (quota, erreur) mis en quarantaine quelques minutes pour ne
// pas retenter à chaque prospect et ralentir tout le job. Un simple 429 (débit
// trop élevé) est temporaire : quarantaine COURTE pour ne pas tuer un gros lot.
const PROVIDER_COOLDOWN_MS = 5 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 15 * 1000;
const cooldownUntil = new Map<string, number>();

/**
 * Renvoie les résultats d'un provider configuré, ou null si aucun n'est
 * configuré/disponible (l'appelant bascule alors sur le scraping public).
 * Un tableau vide signifie « provider OK mais aucun résultat ».
 * `page` (0-based) permet de lire au-delà des ~10 premiers résultats.
 */
export async function apiSearch(query: string, page = 0): Promise<WebResult[] | null> {
  const s = config.search;
  const providers: Array<{ name: string; run: () => Promise<WebResult[]> }> = [];
  if (s.googleApiKey && s.googleCx) providers.push({ name: "google", run: () => googleSearch(query, page) });
  if (s.serperApiKey) providers.push({ name: "serper", run: () => serperSearch(query, page) });
  if (s.braveApiKey) providers.push({ name: "brave", run: () => braveSearch(query, page) });
  if (!providers.length) return null;

  const hit = cacheGet.get(query, page) as { results: string } | undefined;
  if (hit) return JSON.parse(hit.results) as WebResult[];

  let lastError: unknown = null;
  for (const p of providers) {
    if ((cooldownUntil.get(p.name) ?? 0) > Date.now()) continue;
    try {
      const results = await p.run();
      cachePut.run(query, page, JSON.stringify(results), Date.now());
      return results;
    } catch (err) {
      lastError = err;
      const rateLimited = /\b429\b/.test(err instanceof Error ? err.message : String(err));
      cooldownUntil.set(p.name, Date.now() + (rateLimited ? RATE_LIMIT_COOLDOWN_MS : PROVIDER_COOLDOWN_MS));
    }
  }
  // tous les providers configurés sont en panne/quarantaine
  if (lastError) console.warn(`[b2b] recherche API indisponible : ${lastError instanceof Error ? lastError.message : lastError}`);
  return null;
}

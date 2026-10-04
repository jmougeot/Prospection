/**
 * LinkedIn : offres lues sur la recherche PUBLIQUE d'offres, celle que voit un
 * visiteur non connecté. Aucun compte, aucun cookie : cette source ne touche
 * jamais aux comptes LinkedIn utilisés pour la prospection.
 *
 * Source non officielle (contraire aux conditions de LinkedIn) et vite limitée :
 * peu d'appels, espacés, et tout refus (429, 999, redirection vers la connexion)
 * arrête la lecture sans nouvelle tentative. Les fiches ne donnent ni le texte de
 * l'offre ni le site de l'entreprise.
 */
import { type Posting } from "../ats.js";

export interface LinkedinResult {
  postings: Posting[];
  requests: number;
  error: string | null;
}

const SEARCH_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const KEYWORDS = ["développeur", "software engineer", "data engineer", "data scientist", "machine learning", "devops", "backend", "frontend", "fullstack"];
const PAGE = 10; // fiches par page, imposé par le site
const MAX_START = 990; // au-delà, la recherche publique ne renvoie plus rien
const TIMEOUT = 20000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fiches d'une page de résultats (HTML) → offres. */
export function parseLinkedinCards(html: string): Posting[] {
  const out: Posting[] = [];
  for (const card of html.split(/<li[\s>]/).slice(1)) {
    const id = /jobPosting:(\d+)/.exec(card)?.[1];
    const title = /base-search-card__title[^>]*>\s*([^<]+)/.exec(card)?.[1];
    const company = /base-search-card__subtitle[^>]*>\s*(?:<a[^>]*>)?\s*([^<]+)/.exec(card)?.[1];
    const location = /job-search-card__location[^>]*>\s*([^<]+)/.exec(card)?.[1];
    const url = /href="(https:\/\/[a-z]+\.linkedin\.com\/jobs\/view\/[^"?]+)/.exec(card)?.[1];
    const day = /datetime="([^"]+)"/.exec(card)?.[1];
    if (!id || !title || !url) continue;
    out.push({
      external_id: id,
      title: decode(title),
      company: company ? decode(company) : null,
      department: null,
      location: location ? decode(location) : null,
      country: "France", // la recherche est restreinte à la France ; le lieu affiché se réduit parfois à la ville
      remote: false,
      url,
      description: null,
      posted_at: day && Number.isFinite(Date.parse(day)) ? Date.parse(day) : null,
    });
  }
  return out;
}

/**
 * Offres tech en France publiées depuis `hours` heures (24 par défaut), les plus
 * récentes d'abord, en au plus `maxRequests` appels. Ne lève jamais.
 */
export async function fetchLinkedinJobs(
  opts: { maxRequests?: number; delayMs?: number; hours?: number } = {}
): Promise<LinkedinResult> {
  const maxRequests = opts.maxRequests ?? 40;
  const delayMs = Math.max(1000, opts.delayMs ?? 1500);
  const out: LinkedinResult = { postings: [], requests: 0, error: null };
  const seen = new Set<string>();
  const exhausted = new Set<string>();

  // Première page de chaque mot-clé, puis les suivantes : un petit plafond couvre tous les métiers.
  for (let start = 0; start <= MAX_START && exhausted.size < KEYWORDS.length; start += PAGE) {
    for (const keywords of KEYWORDS) {
      if (exhausted.has(keywords)) continue;
      if (out.requests >= maxRequests) return out;
      if (out.requests) await sleep(delayMs);
      out.requests++;
      const params = new URLSearchParams({
        keywords,
        location: "France",
        f_TPR: `r${Math.round((opts.hours ?? 24) * 3600)}`,
        sortBy: "DD",
        start: String(start),
      });
      try {
        const res = await fetch(`${SEARCH_URL}?${params}`, {
          headers: { "user-agent": UA, "accept-language": "fr-FR,fr;q=0.9" },
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT),
        });
        if (res.status !== 200) {
          out.error = `bloqué : HTTP ${res.status}`;
          return out;
        }
        const cards = parseLinkedinCards(await res.text());
        if (cards.length < PAGE) exhausted.add(keywords);
        for (const p of cards) {
          if (seen.has(p.external_id)) continue;
          seen.add(p.external_id);
          out.postings.push(p);
        }
      } catch (err) {
        out.error = err instanceof Error ? err.message : String(err);
        return out;
      }
    }
  }
  return out;
}

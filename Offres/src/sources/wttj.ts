/**
 * Welcome to the Jungle : offres tech en France lues sur le moteur de recherche
 * que le site met à disposition de tout visiteur anonyme (identifiants publics
 * servis par /api/env, lus à chaque passage, jamais stockés).
 *
 * Les pages d'offres elles-mêmes sont derrière un pare-feu anti-robots : on ne
 * les charge pas. Le moteur ne rend que 1000 résultats par requête ; on découpe
 * donc la période de publication en tranches jusqu'à passer sous ce plafond.
 *
 * Source non officielle (pas d'API publique documentée, usage contraire aux
 * conditions du site) : elle peut cesser de répondre à tout moment. Tout refus
 * (401, 403, 429) arrête la lecture, sans nouvelle tentative.
 */
import { type Posting } from "../ats.js";

export interface WttjResult {
  postings: Posting[];
  requests: number;
  error: string | null;
}

const SITE = "https://www.welcometothejungle.com";
const INDEX = "wttj_jobs_production_fr";
// Catégorie « Technologie et ingénierie » du site, restreinte aux bureaux en France.
const FILTERS = "offices.country_code:FR AND new_profession.category_reference:tech-engineering-3NjUy";
const PAGE = 1000; // plafond de résultats par requête
const TIMEOUT = 30000;
const DESCRIPTION_MAX = 8000;
const DAY_S = 86400;
const FIELDS = ["name", "slug", "reference", "organization.name", "organization.slug", "offices", "remote", "published_at",
  "published_at_timestamp", "new_profession", "summary", "key_missions", "profile"];

type Obj = Record<string, any>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function toText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function mapHit(h: Obj): Posting {
  const offices = ((h.offices ?? []) as Obj[]).filter((o) => o?.country_code === "FR");
  const places = [...new Set(offices.map((o) => [o.city, "France"].filter(Boolean).join(", ")))];
  const text = [h.summary, ...((h.key_missions ?? []) as string[]), h.profile ? toText(String(h.profile)) : null]
    .filter(Boolean)
    .join("\n");
  return {
    external_id: String(h.reference ?? h.objectID ?? ""),
    title: String(h.name ?? "").trim(),
    company: typeof h.organization?.name === "string" ? h.organization.name.trim() : null,
    // sous-catégorie seule : la catégorie mêle informatique et ingénierie industrielle
    department: h.new_profession?.sub_category_name ?? null,
    location: places.length ? places.join(" · ") : null,
    country: offices.length ? "FR" : null,
    remote: h.remote === "fulltime",
    url: `${SITE}/fr/companies/${h.organization?.slug}/jobs/${h.slug}`,
    description: text ? text.slice(0, DESCRIPTION_MAX) : null,
    posted_at: Number.isFinite(Date.parse(h.published_at)) ? Date.parse(h.published_at) : null,
  };
}

/**
 * Offres tech en France actuellement en ligne (publiées depuis `days` jours si
 * précisé). S'arrête à `maxRequests` appels HTTP. Ne lève jamais.
 */
export async function fetchWttjJobs(
  opts: { maxRequests?: number; delayMs?: number; days?: number } = {}
): Promise<WttjResult> {
  const maxRequests = opts.maxRequests ?? 60;
  const delayMs = Math.max(300, opts.delayMs ?? 500);
  const out: WttjResult = { postings: [], requests: 0, error: null };
  const seen = new Set<string>();

  const call = async (url: string, init?: RequestInit): Promise<Response | null> => {
    if (out.requests >= maxRequests) return null;
    if (out.requests) await sleep(delayMs);
    out.requests++;
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`${[401, 403, 429].includes(res.status) ? "bloqué : " : ""}HTTP ${res.status}`);
    return res;
  };

  try {
    const env = await (await call(`${SITE}/api/env`))!.text();
    const read = (name: string): string => new RegExp(`"?${name}"?\\s*:\\s*"([^"]+)"`).exec(env)?.[1] ?? "";
    const appId = read("PUBLIC_ALGOLIA_APPLICATION_ID");
    const apiKey = read("PUBLIC_ALGOLIA_API_KEY_CLIENT");
    if (!appId || !apiKey) throw new Error("identifiants de recherche introuvables sur le site");

    // Lit une tranche [from, to[ de dates de publication ; la coupe en deux tant qu'elle dépasse le plafond.
    const readRange = async (from: number, to: number): Promise<void> => {
      const res = await call(`https://${appId.toLowerCase()}-dsn.algolia.net/1/indexes/${INDEX}/query`, {
        method: "POST",
        headers: {
          "X-Algolia-Application-Id": appId,
          "X-Algolia-API-Key": apiKey,
          "content-type": "application/json",
          Referer: `${SITE}/`,
          Origin: SITE,
        },
        body: JSON.stringify({
          query: "",
          hitsPerPage: PAGE,
          filters: FILTERS,
          numericFilters: [`published_at_timestamp>=${from}`, `published_at_timestamp<${to}`],
          attributesToRetrieve: FIELDS,
          attributesToHighlight: [],
        }),
      });
      if (!res) return; // plafond d'appels atteint : on garde ce qui est lu
      const data = (await res.json()) as { nbHits?: number; hits?: Obj[] };
      if ((data.nbHits ?? 0) > PAGE && to - from > DAY_S) {
        const mid = Math.floor((from + to) / 2);
        await readRange(mid, to); // les plus récentes d'abord
        await readRange(from, mid);
        return;
      }
      for (const h of data.hits ?? []) {
        const p = mapHit(h);
        if (!p.external_id || !p.title || !h.organization?.slug || !h.slug || seen.has(p.external_id)) continue;
        seen.add(p.external_id);
        out.postings.push(p);
      }
    };

    const now = Math.floor(Date.now() / 1000) + DAY_S;
    // sans `days` : tout ce qui est en ligne (les offres restent rarement plus de deux ans)
    await readRange(now - (opts.days ?? 730) * DAY_S, now);
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  out.postings.sort((a, b) => (b.posted_at ?? 0) - (a.posted_at ?? 0));
  return out;
}

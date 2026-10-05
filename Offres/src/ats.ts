/**
 * Lecture des pages carrières hébergées par les ATS (Greenhouse, Lever, Ashby,
 * SmartRecruiters, Workable). Chacun expose un flux JSON PUBLIC par entreprise
 * (identifiée par son « slug ») : pas de clé, pas de scraping, et les offres
 * sont publiées en direct par l'entreprise (jamais par un cabinet).
 *
 * Chaque lecteur renvoie les offres normalisées en `Posting` ; le tri France /
 * tech se fait ensuite dans classify.ts.
 */

export const ATS_LIST = ["greenhouse", "lever", "ashby", "smartrecruiters", "workable"] as const;
export type Ats = (typeof ATS_LIST)[number];

export interface Posting {
  external_id: string; // identifiant de l'offre chez l'ATS
  title: string;
  company: string | null; // nom affiché par l'ATS (null s'il ne le donne pas)
  department: string | null;
  location: string | null; // tous les lieux de l'offre, joints par « · »
  country: string | null; // pays (code ISO ou nom) quand l'ATS le fournit à part
  remote: boolean;
  url: string;
  description: string | null; // texte brut, tronqué
  posted_at: number | null; // date de publication (ms)
  modified_at?: number | null; // dernière modification de la page de l'offre, quand elle a été lue (voir sources/job-date.ts)
}

const TIMEOUT = 20000;
const DESCRIPTION_MAX = 8000;

/** Slug inconnu de l'ATS (404) : à distinguer d'une panne transitoire. */
export class BoardNotFound extends Error {}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT) });
  if (res.status === 404) throw new BoardNotFound("page carrières introuvable");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** HTML (éventuellement échappé en entités, cf. Greenhouse) → texte brut tronqué. */
function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  const raw = /<[a-z]/i.test(html) ? html : decodeEntities(html);
  const text = decodeEntities(
    raw
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return text ? text.slice(0, DESCRIPTION_MAX) : null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const date = (v: unknown): number | null => {
  const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const joinPlaces = (places: Array<string | null | undefined>): string | null => {
  const uniq = [...new Set(places.map((p) => (p ?? "").trim()).filter(Boolean))];
  return uniq.length ? uniq.join(" · ") : null;
};

type Obj = Record<string, any>;

async function greenhouse(slug: string): Promise<Posting[]> {
  const data = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`)) as Obj;
  return ((data.jobs ?? []) as Obj[]).map((j) => {
    const location = str(j.location?.name);
    return {
      external_id: String(j.id),
      title: String(j.title ?? "").trim(),
      company: str(j.company_name),
      department: str(j.departments?.[0]?.name),
      location,
      country: null,
      remote: /remote|télétravail|teletravail/i.test(location ?? ""),
      url: String(j.absolute_url ?? ""),
      description: htmlToText(j.content),
      posted_at: date(j.first_published) ?? date(j.updated_at),
    };
  });
}

async function lever(slug: string): Promise<Posting[]> {
  // Deux instances (US et UE) : un slug n'existe que sur l'une des deux.
  let data: unknown;
  try {
    data = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
  } catch (err) {
    if (!(err instanceof BoardNotFound)) throw err;
    data = await getJson(`https://api.eu.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
  }
  return ((Array.isArray(data) ? data : []) as Obj[]).map((j) => ({
    external_id: String(j.id),
    title: String(j.text ?? "").trim(),
    company: null,
    department: str(j.categories?.team) ?? str(j.categories?.department),
    location: joinPlaces([j.categories?.location, ...((j.categories?.allLocations ?? []) as string[])]),
    country: str(j.country),
    remote: j.workplaceType === "remote",
    url: String(j.hostedUrl ?? ""),
    description: str(j.descriptionPlain)?.slice(0, DESCRIPTION_MAX) ?? htmlToText(j.description),
    posted_at: date(j.createdAt),
  }));
}

async function ashby(slug: string): Promise<Posting[]> {
  const data = (await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`)) as Obj;
  return ((data.jobs ?? []) as Obj[])
    .filter((j) => j.isListed !== false)
    .map((j) => ({
      external_id: String(j.id),
      title: String(j.title ?? "").trim(),
      company: null,
      department: str(j.department) ?? str(j.team),
      location: joinPlaces([j.location, ...((j.secondaryLocations ?? []) as Obj[]).map((l) => l?.location)]),
      country: str(j.address?.postalAddress?.addressCountry),
      remote: j.isRemote === true || j.workplaceType === "Remote",
      url: String(j.jobUrl ?? ""),
      description: str(j.descriptionPlain)?.slice(0, DESCRIPTION_MAX) ?? htmlToText(j.descriptionHtml),
      posted_at: date(j.publishedAt),
    }));
}

async function smartrecruiters(slug: string): Promise<Posting[]> {
  // Seul ATS filtrable par pays côté serveur : on ne lit que la France. La liste
  // ne contient pas le texte de l'offre (il faudrait un appel par offre).
  const out: Posting[] = [];
  const LIMIT = 100;
  for (let offset = 0; offset < 1000; offset += LIMIT) {
    const data = (await getJson(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?country=fr&limit=${LIMIT}&offset=${offset}`
    )) as Obj;
    const content = (data.content ?? []) as Obj[];
    for (const j of content) {
      out.push({
        external_id: String(j.id),
        title: String(j.name ?? "").trim(),
        company: str(j.company?.name),
        department: str(j.function?.label) ?? str(j.department?.label),
        location: str(j.location?.fullLocation) ?? joinPlaces([j.location?.city, j.location?.region]),
        country: str(j.location?.country),
        remote: j.location?.remote === true,
        url: `https://jobs.smartrecruiters.com/${encodeURIComponent(j.company?.identifier ?? slug)}/${j.id}`,
        description: null,
        posted_at: date(j.releasedDate),
      });
    }
    if (content.length < LIMIT || out.length >= (Number(data.totalFound) || 0)) break;
  }
  return out;
}

async function workable(slug: string): Promise<Posting[]> {
  const data = (await getJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`)) as Obj;
  const company = str(data.name);
  return ((data.jobs ?? []) as Obj[]).map((j) => {
    const places = ((j.locations ?? []) as Obj[]).map((l) => [l?.city, l?.country].filter(Boolean).join(", "));
    return {
      external_id: String(j.shortcode),
      title: String(j.title ?? "").trim(),
      company,
      department: str(j.department) ?? str(j.function),
      location: joinPlaces([[j.city, j.country].filter(Boolean).join(", "), ...places]),
      country: str(j.country),
      remote: j.telecommuting === true,
      url: String(j.url ?? j.shortlink ?? ""),
      description: htmlToText(j.description),
      posted_at: date(j.published_on) ?? date(j.created_at),
    };
  });
}

const READERS: Record<Ats, (slug: string) => Promise<Posting[]>> = { greenhouse, lever, ashby, smartrecruiters, workable };

/** Toutes les offres publiées d'une entreprise. Lève BoardNotFound si le slug n'existe pas. */
export async function fetchBoard(ats: Ats, slug: string): Promise<Posting[]> {
  return (await READERS[ats](slug)).filter((p) => p.external_id && p.title && p.url);
}

/**
 * Reconnaît une page carrières à partir d'une URL d'offre (résultat de recherche
 * ou saisie manuelle) ou d'un couple « ats:slug ». Renvoie null si ce n'est pas
 * un ATS géré.
 */
export function parseBoardRef(input: string): { ats: Ats; slug: string } | null {
  const raw = input.trim();
  const pair = /^([a-z]+)\s*:\s*([\w.-]+)$/i.exec(raw);
  if (pair && (ATS_LIST as readonly string[]).includes(pair[1].toLowerCase())) {
    return { ats: pair[1].toLowerCase() as Ats, slug: pair[2] };
  }
  let u: URL;
  let seg: string;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    seg = decodeURIComponent(u.pathname.split("/").filter(Boolean)[0] ?? "");
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  let ats: Ats | null = null;
  let slug = seg;
  if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host)) {
    ats = "greenhouse";
    if (seg === "embed") slug = u.searchParams.get("for") ?? "";
  } else if (/^jobs(\.eu)?\.lever\.co$/.test(host)) ats = "lever";
  else if (host === "jobs.ashbyhq.com") ats = "ashby";
  else if (/^(jobs|careers)\.smartrecruiters\.com$/.test(host)) ats = "smartrecruiters";
  else if (host === "apply.workable.com" && seg !== "j") ats = "workable";
  // un slug est un identifiant simple ; tout le reste (chemins techniques, vide) est écarté
  if (!ats || !/^[\w.-]{2,80}$/.test(slug)) return null;
  // SmartRecruiters est sensible à la casse ; les autres ont des slugs en minuscules
  return { ats, slug: ats === "smartrecruiters" ? slug : slug.toLowerCase() };
}

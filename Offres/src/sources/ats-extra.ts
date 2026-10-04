/**
 * Lecteurs d'ATS supplémentaires, sur le même modèle que ats.ts : un flux PUBLIC
 * par entreprise (identifiée par son « slug »), sans clé, publié par l'entreprise
 * elle-même. Formats vérifiés en direct (cf. scripts/test-ats-extra.ts) :
 *
 *  - teamtailor : flux RSS   https://<slug>.teamtailor.com/jobs.rss
 *  - recruitee  : JSON       https://<slug>.recruitee.com/api/offers/
 *  - personio   : XML        https://<slug>.jobs.personio.com/xml (ou .de)
 *  - breezy     : JSON       https://<slug>.breezy.hr/json            (sans texte d'offre)
 *  - flatchr    : JSON       https://careers.flatchr.io/company/<slug>.json
 *  - taleez     : JSON       https://<slug>.taleez.com/api/careez     (sans texte d'offre)
 *  - pinpoint   : JSON       https://<slug>.pinpointhq.com/postings.json
 *  - join       : page HTML  https://join.com/companies/<slug> (données __NEXT_DATA__,
 *                 5 offres par page, sans texte d'offre)
 *
 *  - bamboohr   : JSON       https://<slug>.bamboohr.com/careers/list (sans texte, pays ni date)
 *
 * Écartés faute de flux public exploitable : JazzHR (HTML seul), Welcome Kit (API à jeton).
 */
import { type Posting, BoardNotFound } from "../ats.js";

export const EXTRA_ATS_LIST = ["teamtailor", "recruitee", "personio", "breezy", "flatchr", "taleez", "pinpoint", "join", "bamboohr"] as const;
export type ExtraAts = (typeof EXTRA_ATS_LIST)[number];

const TIMEOUT = 20000;
const DESCRIPTION_MAX = 8000;
// Certains sites carrières (Join, Flatchr) refusent les clients sans User-Agent de navigateur.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * GET sans suivre les redirections : plusieurs ATS renvoient un slug inconnu vers
 * leur site vitrine (30x) au lieu d'un 404.
 */
async function get(url: string, accept: string): Promise<string> {
  const res = await fetch(url, {
    headers: { accept, "user-agent": UA },
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (res.status === 404 || res.status === 410 || (res.status >= 300 && res.status < 400)) {
    throw new BoardNotFound("page carrières introuvable");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** JSON attendu : une page HTML renvoyée en 200 (page « introuvable » maquillée) vaut slug inconnu. */
async function getJson(url: string): Promise<unknown> {
  const body = await get(url, "application/json");
  try {
    return JSON.parse(body);
  } catch {
    if (/^\s*</.test(body)) throw new BoardNotFound("page carrières introuvable");
    throw new Error("réponse JSON illisible");
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** HTML (éventuellement échappé en entités, cf. RSS Teamtailor) → texte brut tronqué. */
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
const place = (...parts: unknown[]): string => [...new Set(parts.map((p) => str(p)).filter(Boolean))].join(", ");
/** Offre multi-pays : `country` n'a qu'une valeur, on privilégie la France si elle y figure. */
const pickCountry = (countries: Array<string | null | undefined>): string | null => {
  const list = countries.map((c) => (c ?? "").trim()).filter(Boolean);
  return list.find((c) => /^(fr|fra|france)$/i.test(c)) ?? list[0] ?? null;
};
const REMOTE_RE = /remote|télétravail|teletravail/i;

type Obj = Record<string, any>;

// --- XML / RSS : extraction par expressions régulières (pas de dépendance) ---

const xmlBlocks = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
/** Contenu texte de la première balise `tag` (CDATA déballé, entités décodées une fois). */
function xmlText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!m) return null;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(m[1]);
  return str(cdata ? cdata[1] : decodeEntities(m[1]));
}

async function teamtailor(slug: string): Promise<Posting[]> {
  // « slug » avec un point = domaine carrières personnalisé (careers.exemple.com), qui sert le même flux.
  const host = slug.includes(".") ? slug : `${encodeURIComponent(slug)}.teamtailor.com`;
  // per_page élevé par précaution : le flux observé renvoie tout d'un coup (73 offres sur un compte).
  const xml = await get(`https://${host}/jobs.rss?per_page=500`, "application/rss+xml, application/xml, text/xml");
  if (!/<rss[\s>]/.test(xml)) throw new BoardNotFound("flux RSS Teamtailor introuvable");
  const company = xmlText(xml.split("<item>")[0], "title");
  return xmlBlocks(xml, "item").map((item) => {
    const locs = xmlBlocks(item, "tt:location").map((l) => ({
      city: xmlText(l, "tt:city") ?? xmlText(l, "tt:name"),
      country: xmlText(l, "tt:country"),
    }));
    const url = xmlText(item, "link") ?? "";
    return {
      // le guid est stable ; à défaut, l'identifiant numérique de l'URL
      external_id: xmlText(item, "guid") ?? /\/jobs\/(\d+)/.exec(url)?.[1] ?? "",
      title: xmlText(item, "title") ?? "",
      company,
      department: xmlText(item, "tt:department"),
      location: joinPlaces(locs.map((l) => place(l.city, l.country))),
      country: pickCountry(locs.map((l) => l.country)),
      remote: xmlText(item, "remoteStatus") === "fully",
      url,
      description: htmlToText(xmlText(item, "description")),
      posted_at: date(xmlText(item, "pubDate")),
    };
  });
}

async function recruitee(slug: string): Promise<Posting[]> {
  const data = (await getJson(`https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`)) as Obj;
  return ((data.offers ?? []) as Obj[])
    .filter((j) => !j.status || j.status === "published")
    .map((j) => {
      const locs = (j.locations ?? []) as Obj[];
      return {
        external_id: String(j.id ?? ""),
        title: String(j.title ?? "").trim(),
        company: str(j.company_name),
        department: str(j.department),
        location: joinPlaces([j.location ?? place(j.city, j.country), ...locs.map((l) => place(l?.city ?? l?.name, l?.country))]),
        country: pickCountry([j.country_code, ...locs.map((l) => l?.country_code)]) ?? str(j.country),
        remote: j.remote === true,
        url: String(j.careers_url ?? ""),
        description: htmlToText([j.description, j.requirements].filter(Boolean).join("\n")),
        posted_at: date(j.published_at) ?? date(j.created_at),
      };
    });
}

async function personio(slug: string): Promise<Posting[]> {
  // Deux domaines (.com et .de) servent le même flux ; on essaie l'autre si le premier ne connaît pas le slug.
  let tld = "com";
  let xml: string;
  try {
    xml = await get(`https://${encodeURIComponent(slug)}.jobs.personio.com/xml`, "application/xml, text/xml");
  } catch (err) {
    if (!(err instanceof BoardNotFound)) throw err;
    tld = "de";
    xml = await get(`https://${encodeURIComponent(slug)}.jobs.personio.de/xml`, "application/xml, text/xml");
  }
  if (!/<workzag-jobs[\s>/]/.test(xml)) throw new BoardNotFound("flux XML Personio introuvable");
  return xmlBlocks(xml, "position").map((pos) => {
    // Le texte est découpé en sections titrées ; on le retire pour lire les autres balises
    // (une section s'appelle aussi <name>).
    const descBlock = xmlBlocks(pos, "jobDescriptions")[0] ?? "";
    const head = pos.replace(/<jobDescriptions>[\s\S]*?<\/jobDescriptions>/, "");
    const id = xmlText(head, "id") ?? "";
    // Pas de pays dans le flux : seulement des noms de bureaux (« FR | Paris », « Remote »…).
    const location = joinPlaces(xmlBlocks(head, "office").map((o) => decodeEntities(o)));
    const sections = xmlBlocks(descBlock, "jobDescription").map((s) =>
      [xmlText(s, "name"), xmlText(s, "value")].filter(Boolean).join("<br>")
    );
    return {
      external_id: id,
      title: xmlText(head, "name") ?? "",
      company: xmlText(head, "subcompany"),
      department: xmlText(head, "department") ?? xmlText(head, "recruitingCategory"),
      location,
      country: null,
      remote: REMOTE_RE.test(location ?? ""),
      url: id ? `https://${slug}.jobs.personio.${tld}/job/${id}` : "",
      description: htmlToText(sections.join("<br>")),
      posted_at: date(xmlText(head, "createdAt")),
    };
  });
}

async function breezy(slug: string): Promise<Posting[]> {
  // La liste ne contient pas le texte de l'offre (il faudrait lire chaque page d'offre).
  const data = await getJson(`https://${encodeURIComponent(slug)}.breezy.hr/json`);
  return ((Array.isArray(data) ? data : []) as Obj[]).map((j) => {
    const locs = ([j.location, ...((j.locations ?? []) as Obj[])] as Obj[]).filter(Boolean);
    return {
      external_id: String(j.id ?? ""),
      title: String(j.name ?? "").trim(),
      company: str(j.company?.name),
      department: str(j.department),
      location: joinPlaces(locs.map((l) => str(l.name) ?? place(l.city, l.country?.name))),
      country: pickCountry(locs.map((l) => l.country?.id)),
      remote: locs.some((l) => l.is_remote === true),
      url: String(j.url ?? ""),
      description: null,
      posted_at: date(j.published_date),
    };
  });
}

async function flatchr(slug: string): Promise<Posting[]> {
  const data = (await getJson(`https://careers.flatchr.io/company/${encodeURIComponent(slug)}.json`)) as Obj;
  return ((data.items ?? []) as Obj[])
    .filter((it) => it.vacancy && it.published !== false)
    .map((it) => {
      const v = it.vacancy as Obj;
      const a = (v.address ?? {}) as Obj;
      return {
        external_id: String(v.id ?? v.vacancy_id ?? ""),
        title: String(v.title ?? "").trim(),
        company: str(v.company?.name),
        // « activity » est le secteur du poste (« Informatique »…) ; les tags sont des dossiers internes
        department: str(v.activity) ?? str(v.tags?.[0]?.title),
        location: place(a.locality, a.administrative_area_level_1, a.country) || str(v.addressFormatted),
        country: str(a.country),
        remote: v.remote === "fulltime",
        url: v.slug ? `https://careers.flatchr.io/fr/company/${encodeURIComponent(slug)}/vacancy/${v.slug}/` : "",
        description: htmlToText([v.description, v.mission, v.profile].filter(Boolean).join("\n")),
        posted_at: date(it.created_at) ?? date(v.created_at),
      };
    });
}

async function taleez(slug: string): Promise<Posting[]> {
  // Données du site carrières (celles que charge la page) : liste des offres sans leur texte.
  const data = (await getJson(`https://${encodeURIComponent(slug)}.taleez.com/api/careez`)) as Obj;
  const company = str(data.name);
  // Le service / le métier sont des « propriétés » à choix, référencées par identifiant dans chaque offre.
  const labels = new Map<number, string>();
  let deptProps: Obj[] = [];
  for (const type of ["DEPARTMENT", "PROFILE"]) {
    deptProps = deptProps.concat(((data.properties ?? []) as Obj[]).filter((p) => p.lockedType === type));
  }
  for (const p of deptProps) for (const c of (p.choices ?? []) as Obj[]) labels.set(c.id, String(c.value ?? ""));
  return ((data.jobs ?? []) as Obj[]).map((j) => {
    const l = (j.location ?? {}) as Obj;
    let department: string | null = null;
    for (const p of deptProps) {
      const choice = ((j.properties ?? []) as Obj[]).find((x) => x.id === p.id)?.choices?.[0];
      department = str(labels.get(choice));
      if (department) break;
    }
    return {
      external_id: String(j.id ?? ""),
      title: String(j.label ?? "").trim(),
      company,
      department,
      location: place(l.city, l.region) || null,
      country: str(l.country),
      remote: j.remote === true,
      url: j.slug ? `https://taleez.com/apply/${j.slug}` : "",
      description: null,
      posted_at: date(j.publishDate) ?? date(j.creationDate),
    };
  });
}

async function pinpoint(slug: string): Promise<Posting[]> {
  // Ni nom d'entreprise, ni pays, ni date de publication dans ce flux.
  const data = (await getJson(`https://${encodeURIComponent(slug)}.pinpointhq.com/postings.json`)) as Obj;
  return ((data.data ?? []) as Obj[]).map((j) => {
    const location = str(j.location?.name) ?? (place(j.location?.city, j.location?.province) || null);
    return {
      external_id: String(j.id ?? ""),
      title: String(j.title ?? "").trim(),
      company: null,
      department: str(j.job?.department?.name) ?? str(j.job?.division?.name),
      location,
      country: null,
      remote: j.workplace_type === "remote" || REMOTE_RE.test(location ?? ""),
      url: String(j.url ?? ""),
      description: htmlToText([j.description, j.key_responsibilities, j.skills_knowledge_expertise].filter(Boolean).join("\n")),
      posted_at: null,
    };
  });
}

const JOIN_MAX_PAGES = 40; // 5 offres par page (taille imposée par le site) → 200 offres au plus
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function join(slug: string): Promise<Posting[]> {
  // Pas de flux : on lit l'état embarqué dans la page entreprise (Next.js), page par page.
  const out: Posting[] = [];
  for (let page = 1; page <= JOIN_MAX_PAGES; page++) {
    if (page > 1) await sleep(300);
    const html = await get(`https://join.com/companies/${encodeURIComponent(slug)}?page=${page}`, "text/html");
    const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!m) throw new Error("page Join illisible (__NEXT_DATA__ absent)");
    const st = (JSON.parse(m[1]) as Obj)?.props?.pageProps?.initialState as Obj | undefined;
    if (!st?.company) throw new BoardNotFound("entreprise Join introuvable");
    const items = (st.jobs?.items ?? []) as Obj[];
    for (const j of items) {
      out.push({
        external_id: String(j.id ?? ""),
        title: String(j.title ?? "").trim(),
        company: str(st.company.name),
        department: str(j.category?.name),
        location: place(j.city?.cityName, j.city?.countryName) || null,
        country: str(j.country?.iso3166),
        remote: j.workplaceType === "REMOTE",
        url: j.idParam ? `https://join.com/companies/${encodeURIComponent(slug)}/${j.idParam}` : "",
        description: null,
        posted_at: date(j.createdAt),
      });
    }
    if (!items.length || page >= (Number(st.jobs?.pagination?.pageCount) || 0)) break;
  }
  return out;
}

async function bamboohr(slug: string): Promise<Posting[]> {
  // Liste légère : ville et région seulement (pas de pays), ni texte ni date (un appel par offre sinon).
  const data = (await getJson(`https://${encodeURIComponent(slug)}.bamboohr.com/careers/list`)) as Obj;
  return ((data.result ?? []) as Obj[]).map((j) => {
    const location = place(j.location?.city, j.location?.state) || place(j.atsLocation?.city, j.atsLocation?.state) || null;
    return {
      external_id: String(j.id ?? ""),
      title: String(j.jobOpeningName ?? "").trim(),
      company: null,
      department: str(j.departmentLabel),
      location,
      country: str(j.atsLocation?.country),
      remote: j.isRemote === true || String(j.locationType) === "1",
      url: j.id ? `https://${slug}.bamboohr.com/careers/${j.id}` : "",
      description: null,
      posted_at: null,
    };
  });
}

const RAW_READERS: Record<ExtraAts, (slug: string) => Promise<Posting[]>> = {
  teamtailor,
  recruitee,
  personio,
  breezy,
  flatchr,
  taleez,
  pinpoint,
  join,
  bamboohr,
};

/**
 * Toutes les offres publiées d'une entreprise, par ATS (offres sans identifiant,
 * titre ou URL écartées, comme fetchBoard). Lève BoardNotFound si le slug n'existe pas.
 */
export const EXTRA_READERS = Object.fromEntries(
  EXTRA_ATS_LIST.map((ats) => [
    ats,
    async (slug: string) => (await RAW_READERS[ats](slug)).filter((p) => p.external_id && p.title && p.url),
  ])
) as Record<ExtraAts, (slug: string) => Promise<Posting[]>>;

// Sous-domaines qui ne sont pas des entreprises (site vitrine, API, application…).
const RESERVED_SUB = /^(www|app|api|careers?|jobs|blog|help|support|docs|developer|status|cdn|assets|files|static)$/;

/**
 * Même contrat que parseBoardRef (ats.ts) pour ces ATS : URL d'offre ou de page
 * carrières, ou couple « ats:slug » → référence ; null si ce n'est pas un ATS géré ici.
 */
export function parseExtraBoardRef(input: string): { ats: ExtraAts; slug: string } | null {
  const raw = input.trim();
  const pair = /^([a-z]+)\s*:\s*([\w.-]+)$/i.exec(raw);
  if (pair && (EXTRA_ATS_LIST as readonly string[]).includes(pair[1].toLowerCase())) {
    return { ats: pair[1].toLowerCase() as ExtraAts, slug: pair[2].toLowerCase() };
  }
  let u: URL;
  let segs: string[];
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    segs = u.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  let ats: ExtraAts | null = null;
  let slug = "";
  let m: RegExpExecArray | null;
  if ((m = /^([\w-]+)\.(?:[a-z]{2}\.)?teamtailor\.com$/.exec(host))) [ats, slug] = ["teamtailor", m[1]];
  else if ((m = /^([\w-]+)\.recruitee\.com$/.exec(host))) [ats, slug] = ["recruitee", m[1]];
  else if ((m = /^([\w-]+)\.jobs\.personio\.(?:com|de)$/.exec(host))) [ats, slug] = ["personio", m[1]];
  else if ((m = /^([\w-]+)\.breezy\.hr$/.exec(host))) [ats, slug] = ["breezy", m[1]];
  else if ((m = /^([\w-]+)\.pinpointhq\.com$/.exec(host))) [ats, slug] = ["pinpoint", m[1]];
  else if ((m = /^([\w-]+)\.taleez\.com$/.exec(host))) [ats, slug] = ["taleez", m[1]];
  else if ((m = /^([\w-]+)\.bamboohr\.com$/.exec(host))) [ats, slug] = ["bamboohr", m[1]];
  else if (/^([\w-]+\.)?flatchr\.io$/.test(host)) {
    // careers.flatchr.io/[fr/]company/<slug>/… ; les URL /vacancy/<id> seules ne nomment pas l'entreprise
    const i = segs.indexOf("company");
    if (i >= 0 && segs[i + 1]) [ats, slug] = ["flatchr", segs[i + 1].replace(/\.json$/, "")];
  } else if (/^(www\.)?join\.com$/.test(host)) {
    if (segs[0] === "companies" && segs[1]) [ats, slug] = ["join", segs[1]];
  }
  slug = slug.toLowerCase();
  // un slug est un identifiant simple ; les sous-domaines techniques sont écartés
  if (!ats || !/^[\w-]{2,80}$/.test(slug) || RESERVED_SUB.test(slug)) return null;
  return { ats, slug };
}

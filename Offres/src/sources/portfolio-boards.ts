/**
 * Job boards « portfolio » des fonds de capital-risque et des écosystèmes : une
 * seule page publique agrège les offres de toutes les startups d'un fonds. On en
 * tire deux choses : les offres situées en France, et surtout la liste des
 * startups avec l'URL d'ORIGINE de chaque offre (Greenhouse, Lever, Ashby…), que
 * l'intégration transforme en pages carrières suivies via `parseBoardRef`.
 *
 * Trois plateformes, un lecteur générique chacune. On n'appelle que les points
 * d'accès que la page publique appelle elle-même, sans connexion :
 *  - Getro (Accel, Daphni, Seedcamp…) : API JSON de recherche, filtrable par lieu ;
 *  - Consider (XAnge, Serena, Alven…) : API de la page, protégée par un jeton
 *    CSRF que la page fournit à tout visiteur (un GET préalable) ;
 *  - Welcome Kit (Station F) : index Algolia dont la page publie la clé de recherche.
 *
 * Aucune de ces listes ne contient le texte de l'offre : `description` reste null
 * (il faudrait un appel par offre).
 */
import { type Posting } from "../ats.js";

export type PortfolioPlatform = "getro" | "consider" | "welcomekit";

export interface PortfolioBoard {
  key: string;
  name: string;
  platform: PortfolioPlatform;
  url: string; // racine du board, sans chemin (https://jobs.exemple.com)
  networkId?: number; // Getro : identifiant de la « collection » (relu dans la page s'il manque)
  boardId?: string; // Consider : identifiant du board (relu dans la page s'il manque)
}

/**
 * Boards vérifiés en direct (octobre 2026). Les fonds français d'abord, puis les
 * fonds européens et américains dont le portefeuille recrute en France.
 */
export const PORTFOLIO_BOARDS: PortfolioBoard[] = [
  // — écosystème français
  { key: "stationf", name: "Station F", platform: "welcomekit", url: "https://jobs.stationf.co" },
  { key: "xange", name: "XAnge", platform: "consider", url: "https://jobs.xange.vc", boardId: "xange" },
  { key: "serena", name: "Serena", platform: "consider", url: "https://careers.serena.vc", boardId: "serena" },
  { key: "alven", name: "Alven", platform: "consider", url: "https://jobs.alven.co", boardId: "alven" },
  { key: "newfund", name: "Newfund", platform: "consider", url: "https://jobs.newfundcap.com", boardId: "newfund" },
  { key: "quantonation", name: "Quantonation", platform: "consider", url: "https://jobs.quantonation.com", boardId: "quantonation" },
  { key: "daphni", name: "Daphni", platform: "getro", url: "https://talent.daphni.com", networkId: 3359 },
  // — fonds européens
  { key: "balderton", name: "Balderton Capital", platform: "consider", url: "https://careers.balderton.com", boardId: "balderton-capital" },
  { key: "notion", name: "Notion Capital", platform: "consider", url: "https://jobs.notion.vc", boardId: "notion-capital" },
  { key: "headline", name: "Headline", platform: "getro", url: "https://jobs.headline.com", networkId: 3293 },
  { key: "seedcamp", name: "Seedcamp", platform: "getro", url: "https://talent.seedcamp.com", networkId: 4186 },
  { key: "speedinvest", name: "Speedinvest", platform: "getro", url: "https://careers.speedinvest.com", networkId: 947 },
  { key: "pointnine", name: "Point Nine", platform: "getro", url: "https://jobs.pointnine.com", networkId: 1680 },
  { key: "ef", name: "Entrepreneurs First", platform: "getro", url: "https://portfolio.joinef.com", networkId: 228 },
  { key: "cherry", name: "Cherry Ventures", platform: "getro", url: "https://talent.cherry.vc", networkId: 44081 },
  { key: "creandum", name: "Creandum", platform: "getro", url: "https://careers.creandum.com", networkId: 53552 },
  { key: "atomico", name: "Atomico", platform: "getro", url: "https://careers.atomico.com", networkId: 36986 },
  { key: "earlybird", name: "Earlybird", platform: "getro", url: "https://jobs.earlybird.com", networkId: 617 },
  { key: "dawn", name: "Dawn Capital", platform: "getro", url: "https://jobs.dawncapital.com", networkId: 3063 },
  { key: "antler", name: "Antler", platform: "getro", url: "https://careers.antler.co", networkId: 7715 },
  // — fonds américains avec des offres en France
  { key: "accel", name: "Accel", platform: "getro", url: "https://jobs.accel.com", networkId: 8672 },
  { key: "generalcatalyst", name: "General Catalyst", platform: "getro", url: "https://jobs.generalcatalyst.com", networkId: 222 },
  { key: "redpoint", name: "Redpoint Ventures", platform: "getro", url: "https://careers.redpoint.com", networkId: 189 },
  { key: "insight", name: "Insight Partners", platform: "getro", url: "https://jobs.insightpartners.com", networkId: 246 },
  { key: "khosla", name: "Khosla Ventures", platform: "getro", url: "https://jobs.khoslaventures.com", networkId: 257 },
  { key: "thrive", name: "Thrive Capital", platform: "getro", url: "https://jobs.thrivecap.com", networkId: 2105 },
  { key: "techstars", name: "Techstars", platform: "getro", url: "https://jobs.techstars.com", networkId: 89 },
  { key: "sapphire", name: "Sapphire Ventures", platform: "getro", url: "https://jobs.sapphireventures.com", networkId: 199 },
  { key: "lightspeed", name: "Lightspeed", platform: "consider", url: "https://jobs.lsvp.com", boardId: "lightspeed" },
  { key: "sequoia", name: "Sequoia Capital", platform: "consider", url: "https://jobs.sequoiacap.com", boardId: "sequoia-capital" },
  { key: "bessemer", name: "Bessemer Venture Partners", platform: "consider", url: "https://jobs.bvp.com", boardId: "bessemer-ventures" },
  { key: "battery", name: "Battery Ventures", platform: "consider", url: "https://jobs.battery.com", boardId: "battery-ventures" },
  { key: "ivp", name: "IVP", platform: "consider", url: "https://careers.ivp.com", boardId: "ivp" },
  { key: "gv", name: "GV", platform: "consider", url: "https://jobs.gv.com", boardId: "gv" },
  { key: "nea", name: "NEA", platform: "consider", url: "https://careers.nea.com", boardId: "nea" },
];

export interface PortfolioCompany {
  name: string;
  domain: string | null; // domaine du site de la startup, quand le board le donne
  jobUrls: string[]; // URL d'origine des offres (le plus souvent chez l'ATS de la startup)
}

export interface PortfolioResult {
  board: string; // clé du board
  postings: Posting[];
  companies: PortfolioCompany[];
  requests: number; // appels HTTP réellement émis
  error: string | null; // lecture interrompue (403/429, panne…) : le déjà-lu est conservé
}

const TIMEOUT = 20000;
const PAUSE_MS = 400; // délai entre deux appels vers le même serveur
const DEFAULT_MAX_REQUESTS = 15;
// Les boards servent le même contenu à tout navigateur ; on s'annonce comme tel
// pour recevoir la page (et son jeton), sans rien contourner.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

type Obj = Record<string, any>;

/** Refus explicite du serveur (403/429) : on arrête net, sans insister. */
class Refused extends Error {}
/** Plafond d'appels atteint : fin normale de la lecture, pas une erreur. */
class BudgetSpent extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const date = (v: unknown): number | null => {
  // Getro donne des secondes, Consider et Welcome Kit des dates ISO
  const t = typeof v === "number" ? (v < 1e11 ? v * 1000 : v) : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const joinPlaces = (places: Array<string | null | undefined>): string | null => {
  const uniq = [...new Set(places.map((p) => (p ?? "").trim()).filter(Boolean))];
  return uniq.length ? uniq.join(" · ") : null;
};
const cleanDomain = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const host = s
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0];
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
};

/** Compteur d'appels partagé par une lecture : plafond, pause, arrêt sur refus. */
class Session {
  requests = 0;
  cookie = "";
  constructor(private max: number) {}

  get left(): number {
    return this.max - this.requests;
  }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    if (this.requests >= this.max) throw new BudgetSpent();
    if (this.requests > 0) await sleep(PAUSE_MS);
    this.requests++;
    const headers: Record<string, string> = { "user-agent": UA, ...(init.headers as Record<string, string>) };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT) });
    if (res.status === 403 || res.status === 429) throw new Refused(`HTTP ${res.status} (arrêt)`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }

  async json(url: string, init: RequestInit = {}): Promise<Obj> {
    return (await (await this.fetch(url, init)).json()) as Obj;
  }
}

/** Accumule offres et startups ; dédoublonne par identifiant d'offre et par startup. */
class Collector {
  postings: Posting[] = [];
  private seen = new Set<string>();
  private companies = new Map<string, PortfolioCompany>();

  company(id: string, name: string, domain: string | null): PortfolioCompany {
    let c = this.companies.get(id);
    if (!c) this.companies.set(id, (c = { name, domain, jobUrls: [] }));
    else if (!c.domain && domain) c.domain = domain;
    return c;
  }

  add(companyId: string, companyName: string, domain: string | null, p: Posting): void {
    if (!p.external_id || !p.title || !p.url || this.seen.has(p.external_id)) return;
    this.seen.add(p.external_id);
    this.postings.push(p);
    const c = this.company(companyId, companyName, domain);
    if (!c.jobUrls.includes(p.url)) c.jobUrls.push(p.url);
  }

  get companyList(): PortfolioCompany[] {
    return [...this.companies.values()];
  }
}

// ───────────────────────────── Getro ─────────────────────────────

const GETRO_API = "https://api.getro.com/api/v2";
const GETRO_JOBS_PER_PAGE = 20; // imposé par le serveur (hitsPerPage plus grand ignoré)

/** Identifiant de collection lu dans la page (__NEXT_DATA__) quand il n'est pas configuré. */
async function getroNetworkId(board: PortfolioBoard, s: Session): Promise<number> {
  if (board.networkId) return board.networkId;
  const html = await (await s.fetch(`${board.url}/jobs`)).text();
  const m = /"network":\{"id":"?(\d+)/.exec(html);
  if (!m) throw new Error("board Getro : identifiant de collection introuvable");
  return Number(m[1]);
}

async function readGetro(board: PortfolioBoard, s: Session, out: Collector): Promise<void> {
  const id = await getroNetworkId(board, s);
  const search = (type: "jobs" | "companies", page: number): Promise<Obj> =>
    s.json(`${GETRO_API}/collections/${id}/search/${type}`, {
      method: "POST",
      // sans « accept: application/json » l'API répond 406
      headers: { accept: "application/json", "content-type": "application/json", origin: board.url, referer: `${board.url}/` },
      body: JSON.stringify({ hitsPerPage: GETRO_JOBS_PER_PAGE, page, filters: { searchable_locations: ["France"] }, query: "" }),
    });

  // On garde un quart du budget pour les domaines des startups (liste « companies »).
  const reserve = Math.floor(s.left / 4);
  for (let page = 0; s.left > reserve; page++) {
    const r = ((await search("jobs", page)).results ?? {}) as Obj;
    const jobs = (r.jobs ?? []) as Obj[];
    for (const j of jobs) {
      const org = (j.organization ?? {}) as Obj;
      const name = str(org.name);
      if (!name) continue;
      const places = ((j.locations ?? []) as string[]).filter((l) => typeof l === "string");
      const boardPage = `${board.url}/companies/${org.slug}/jobs/${j.slug}`;
      out.add(`g${org.id ?? name}`, name, null, {
        external_id: String(j.id ?? ""),
        title: String(j.title ?? "").trim(),
        company: name,
        department: null,
        location: joinPlaces(places),
        // la recherche est filtrée sur la France : le lieu normalisé le confirme
        country: ((j.searchable_locations ?? []) as string[]).includes("France") ? "France" : null,
        remote: j.work_mode === "remote",
        url: str(j.url) ?? boardPage,
        description: null,
        posted_at: date(j.created_at),
      });
    }
    if (jobs.length < GETRO_JOBS_PER_PAGE || (page + 1) * GETRO_JOBS_PER_PAGE >= (Number(r.count) || 0)) break;
  }

  // Startups du réseau implantées en France : donne le domaine (absent des offres)
  // et des startups sans offre en cours. 12 par page, imposé par le serveur.
  for (let page = 0; s.left > 0; page++) {
    const r = ((await search("companies", page)).results ?? {}) as Obj;
    const companies = (r.companies ?? []) as Obj[];
    for (const c of companies) {
      const name = str(c.name);
      if (name) out.company(`g${c.id ?? name}`, name, cleanDomain(c.domain));
    }
    if (companies.length < 12 || (page + 1) * 12 >= (Number(r.count) || 0)) break;
  }
}

// ──────────────────────────── Consider ────────────────────────────

const CONSIDER_PAGE_SIZE = 100;

/**
 * Une partie des intitulés arrive encodée deux fois chez Consider (« DÃ©marrage »,
 * surtout les offres reprises de Welcome to the Jungle) : on les rétablit quand
 * le texte se relit proprement en UTF-8, sinon on le laisse tel quel.
 */
function fixMojibake(text: string): string {
  if (!/[\u00c2-\u00f4][\u0080-\u00bf]/.test(text) || /[^\u0000-\u00ff]/.test(text)) return text;
  const fixed = Buffer.from(text, "latin1").toString("utf8");
  return fixed.includes("\ufffd") ? text : fixed;
}

async function readConsider(board: PortfolioBoard, s: Session, out: Collector): Promise<void> {
  // La page fournit à tout visiteur un cookie de session et le jeton CSRF associé.
  const page = await s.fetch(`${board.url}/jobs`);
  const html = await page.text();
  s.cookie = page.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("=_remove_"))
    .join("; ");
  const csrf = /"csrfToken":"([^"]+)"/.exec(html)?.[1];
  const boardId = board.boardId ?? /"board":\{"id":"([^"]+)"/.exec(html)?.[1];
  if (!csrf || !boardId) throw new Error("board Consider : jeton ou identifiant introuvable");

  let sequence: string | undefined; // curseur de pagination renvoyé par le serveur
  while (s.left > 0) {
    const data = await s.json(`${board.url}/api-boards/search-jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrf, origin: board.url, referer: `${board.url}/jobs` },
      body: JSON.stringify({
        meta: { size: CONSIDER_PAGE_SIZE, ...(sequence ? { sequence } : {}) },
        board: { id: boardId, isParent: true },
        query: { locations: ["France"] },
      }),
    });
    const jobs = (data.jobs ?? []) as Obj[];
    for (const j of jobs) {
      const name = str(j.companyName) && fixMojibake(str(j.companyName)!);
      if (!name) continue;
      const normalized = ((j.normalizedLocations ?? []) as Obj[]).map((l) => str(l?.value) ?? str(l?.label));
      const slug = str(j.companySlug) ?? name;
      out.add(`c${slug}`, name, cleanDomain(j.companyDomain), {
        external_id: `${slug}:${j.jobId ?? ""}`,
        title: fixMojibake(String(j.title ?? "").trim()),
        company: name,
        department: str(j.departments?.[0]) ?? str(j.jobFunctions?.[0]?.label),
        location: joinPlaces([...((j.locations ?? []) as string[]).map((l) => fixMojibake(String(l))), ...normalized]),
        country: normalized.some((l) => /\bFrance$/.test(l ?? "")) ? "France" : null,
        remote: j.remote === true,
        url: str(j.applyUrl) ?? str(j.url) ?? `${board.url}/jobs`,
        description: null,
        posted_at: date(j.timeStamp),
      });
    }
    sequence = str(data.meta?.sequence) ?? undefined;
    if (jobs.length < CONSIDER_PAGE_SIZE || !sequence) break;
  }
}

// ─────────────────── Welcome Kit (Station F) ───────────────────

const WK_PAGE_SIZE = 100;

async function readWelcomeKit(board: PortfolioBoard, s: Session, out: Collector): Promise<void> {
  // La page de recherche publie l'application Algolia et une clé de recherche
  // restreinte au board (champ caché lu par son propre JavaScript).
  const html = await (await s.fetch(`${board.url}/search`)).text();
  const appId = /algoliaAppId:\s*"([^"]+)"/.exec(html)?.[1];
  const suffix = /algoliaIndexSuffix:\s*"([^"]+)"/.exec(html)?.[1];
  const key = /id="algolia_api_key"[^>]*value="([^"]+)"/.exec(html)?.[1] ?? /value="([^"]+)"[^>]*id="algolia_api_key"/.exec(html)?.[1];
  if (!appId || !suffix || !key) throw new Error("board Welcome Kit : configuration de recherche introuvable");

  for (let page = 0; s.left > 0; page++) {
    const data = await s.json(`https://${appId.toLowerCase()}-dsn.algolia.net/1/indexes/wk_cms_jobs_${suffix}/query`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-algolia-application-id": appId,
        "x-algolia-api-key": key,
        origin: board.url,
        referer: `${board.url}/`,
      },
      body: JSON.stringify({
        params: `query=&hitsPerPage=${WK_PAGE_SIZE}&page=${page}&filters=${encodeURIComponent("offices.country_code:FR")}`,
      }),
    });
    const hits = (data.hits ?? []) as Obj[];
    for (const j of hits) {
      const org = (j.organization ?? {}) as Obj;
      const name = str(org.name);
      const orgSlug = str(org.website_organization?.slug) ?? str(org.slug);
      if (!name || !orgSlug || !str(j.slug)) continue;
      const offices = ((j.offices ?? (j.office ? [j.office] : [])) as Obj[]).filter(Boolean);
      out.add(`w${orgSlug}`, name, null, {
        external_id: str(j.reference) ?? String(j.objectID ?? ""),
        title: String(j.name ?? "").trim(),
        company: name,
        department: str(j.department?.name) ?? str(j.department),
        location: joinPlaces(offices.map((o) => [o.city, o.country].filter(Boolean).join(", "))),
        country: offices.some((o) => o.country_code === "FR") ? "FR" : (str(offices[0]?.country_code) ?? null),
        remote: j.remote === "fulltime",
        // l'offre est hébergée par le board lui-même (pas d'ATS externe)
        url: `${board.url}/companies/${orgSlug}/jobs/${j.slug}`,
        description: null,
        posted_at: date(j.published_at),
      });
    }
    if (hits.length < WK_PAGE_SIZE || page + 1 >= (Number(data.nbPages) || 0)) break;
  }
}

const READERS: Record<PortfolioPlatform, (board: PortfolioBoard, s: Session, out: Collector) => Promise<void>> = {
  getro: readGetro,
  consider: readConsider,
  welcomekit: readWelcomeKit,
};

/**
 * Lit un board, filtré sur la France côté serveur (les trois plateformes le
 * permettent). `maxRequests` plafonne les appels HTTP : une fois atteint, on
 * renvoie ce qui a été lu, sans erreur. Ne lève jamais : `error` porte la cause
 * d'une lecture interrompue (403/429, panne, page modifiée).
 */
export async function readPortfolioBoard(board: PortfolioBoard, maxRequests: number = DEFAULT_MAX_REQUESTS): Promise<PortfolioResult> {
  const s = new Session(Math.max(1, Math.floor(maxRequests)));
  const out = new Collector();
  let error: string | null = null;
  try {
    await READERS[board.platform](board, s, out);
  } catch (err) {
    if (!(err instanceof BudgetSpent)) error = err instanceof Error ? err.message : String(err);
  }
  return { board: board.key, postings: out.postings, companies: out.companyList, requests: s.requests, error };
}

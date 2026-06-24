/**
 * Extraction des champs d'un prospect (prénom, nom, poste, entreprise, lieu) à
 * partir d'un extrait de résultat de recherche (titre + snippet LinkedIn), via
 * Claude Haiku. Bien plus robuste que des regex sur des titres bruités
 * (« Building @Châtaigne I ex-Alan », emojis, taglines marketing…).
 *
 * Garde-fous qualité, dans l'ordre d'importance :
 *  - chaque entrée porte un ID stable (l'URL du profil) que le modèle DOIT
 *    ré-échouer : on remappe la sortie par cet ID, jamais par l'ordre du lot
 *    (le modèle peut sauter/réordonner) ;
 *  - sortie contrainte par un schéma JSON (`output_config.format`) → JSON
 *    toujours valide, pas de parsing fragile ;
 *  - anti-hallucination : champ absent du texte ⇒ chaîne vide (jamais inventé),
 *    ce qui permet à l'appelant de déclencher l'enrichissement entreprise ;
 *  - cache par texte : un snippet déjà interprété ne re-paye jamais (les pages
 *    de recherche étant elles-mêmes cachées, relancer une recherche est gratuit).
 *
 * Sans clé Anthropic, hasExtractor() est faux et l'appelant retombe sur le
 * parsing heuristique de linkedin.ts. Appel en `fetch` brut (comme les autres
 * providers du projet) : pas de dépendance SDK ajoutée.
 */
import crypto from "node:crypto";
import { config } from "../../config.js";
import { db } from "../../db.js";

export interface ExtractedPerson {
  id: string; // URL du profil (clé de remappage)
  first_name: string;
  last_name: string;
  role: string | null; // poste affiché (null si absent)
  company: string | null; // entreprise actuelle (null si absente — surtout pas devinée)
  company_domain: string | null; // domaine du site (probable, non vérifié ; null si incertain)
  headcount_est: string | null; // estimation effectif MONDIAL, ordre de grandeur (null si incertain)
  revenue_est: string | null; // estimation CA annuel, ordre de grandeur (null si incertain — peu fiable)
  location: string | null; // localisation (null si absente)
}

export function hasExtractor(): boolean {
  return Boolean(config.anthropic.apiKey);
}

const cacheGet = db.prepare("SELECT person FROM extract_cache WHERE text_key = ?");
const cachePut = db.prepare("INSERT OR REPLACE INTO extract_cache (text_key, person, fetched_at) VALUES (?, ?, ?)");
const textKey = (text: string): string => crypto.createHash("sha1").update(text).digest("hex");

const API_URL = "https://api.anthropic.com/v1/messages";
const BATCH = 30; // assez gros pour amortir le prompt, assez petit pour réaligner/réessayer

// Tous les champs sont des chaînes (vide = inconnu) : plus simple et plus sûr en
// structured outputs qu'un type nullable, et on convertit "" → null à la lecture.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    people: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          prenom: { type: "string" },
          nom: { type: "string" },
          poste: { type: "string" },
          entreprise: { type: "string" },
          domaine: { type: "string" },
          effectif_estime: { type: "string" },
          ca_estime: { type: "string" },
          lieu: { type: "string" },
        },
        required: ["id", "prenom", "nom", "poste", "entreprise", "domaine", "effectif_estime", "ca_estime", "lieu"],
      },
    },
  },
  required: ["people"],
};

const SYSTEM = [
  "Tu extrais des informations de prospects depuis des extraits de résultats de recherche",
  "(titres + descriptions de profils LinkedIn). Pour chaque entrée du tableau fourni, renvoie",
  "un objet reprenant le `id` reçu À L'IDENTIQUE et les champs extraits du texte de CETTE entrée.",
  "",
  "Règles strictes :",
  "- Renvoie une chaîne vide \"\" pour tout champ dont l'information n'apparaît pas dans le texte.",
  "- N'INVENTE JAMAIS une entreprise ni un lieu. Dans le doute, laisse vide.",
  "- `prenom` et `nom` : sépare-les ; n'y mets que le nom de la personne (jamais l'entreprise,",
  "  le poste, une tagline ou un emoji).",
  "- `poste` : l'intitulé de poste affiché (ex. « Senior Account Executive »), sans l'entreprise.",
  "- `entreprise` : l'employeur ACTUEL uniquement. Ignore les « ex-… », anciennes boîtes, écoles,",
  "  slogans (« Helping companies… », « SaaS B2B »…). Si seul un slogan apparaît, laisse vide.",
  "- `domaine` : le nom de domaine du site officiel de l'entreprise (ex. « salesforce.com »,",
  "  « doctolib.fr »), UNIQUEMENT s'il apparaît dans le texte OU si tu connais ce site avec",
  "  certitude. Sinon laisse vide. N'invente JAMAIS un domaine ni un TLD au hasard.",
  "- `effectif_estime` : estimation du nombre TOTAL de salariés de l'entreprise dans le monde, en",
  "  ordre de grandeur (ex. « ~2 500 », « 10 000+ »), UNIQUEMENT si tu connais l'entreprise et es",
  "  raisonnablement sûr. Sinon laisse vide. N'invente pas un nombre au hasard.",
  "- `ca_estime` : estimation du chiffre d'affaires annuel de l'entreprise, en ordre de grandeur",
  "  (ex. « ~50 M€ », « ~2 Md€ »), UNIQUEMENT si tu connais cette entreprise et es raisonnablement",
  "  sûr. Sinon laisse vide. N'invente JAMAIS un chiffre précis au hasard.",
  "- `lieu` : ville, région ou pays (ex. « Paris », « France »).",
  "- Conserve l'accentuation et la casse d'origine des noms propres.",
  "- Renvoie un objet par entrée, dans le schéma imposé, rien d'autre.",
].join("\n");

interface RawPerson {
  id: string;
  prenom: string;
  nom: string;
  poste: string;
  entreprise: string;
  domaine: string;
  effectif_estime: string;
  ca_estime: string;
  lieu: string;
}

const clean = (s: string): string | null => {
  const t = (s ?? "").trim();
  return t ? t : null;
};

function toPerson(r: RawPerson): ExtractedPerson {
  return {
    id: r.id,
    first_name: (r.prenom ?? "").trim(),
    last_name: (r.nom ?? "").trim(),
    role: clean(r.poste),
    company: clean(r.entreprise),
    company_domain: clean(r.domaine),
    headcount_est: clean(r.effectif_estime),
    revenue_est: clean(r.ca_estime),
    location: clean(r.lieu),
  };
}

/**
 * Un appel Haiku sur un lot d'items. `ok` distingue un appel ABOUTI (réponse
 * 200 parsée) d'un ÉCHEC (réseau, HTTP, JSON illisible) : seul un appel abouti
 * autorise l'appelant à mettre en cache un résultat vide — sinon une panne
 * transitoire (quota, coupure) empoisonnerait le cache et bloquerait les reruns.
 */
async function callApi(
  items: Array<{ id: string; text: string }>
): Promise<{ ok: boolean; people: Map<string, ExtractedPerson> }> {
  const people = new Map<string, ExtractedPerson>();
  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": config.anthropic.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: config.anthropic.model,
        max_tokens: 4096,
        system: SYSTEM,
        messages: [
          { role: "user", content: JSON.stringify(items.map((i) => ({ id: i.id, texte: i.text }))) },
        ],
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
      }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    console.warn(`[b2b] extraction Haiku indisponible : ${err instanceof Error ? err.message : err}`);
    return { ok: false, people };
  }
  if (!res.ok) {
    console.warn(`[b2b] extraction Haiku ${res.status} : ${(await res.text()).slice(0, 120)}`);
    return { ok: false, people };
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((b) => b.type === "text")?.text ?? "";
  try {
    const parsed = (JSON.parse(text).people ?? []) as RawPerson[];
    for (const p of parsed) if (p && typeof p.id === "string") people.set(p.id, toPerson(p));
    return { ok: true, people };
  } catch {
    // 200 mais sortie inexploitable : échec (on ne cache pas, l'appelant retombe sur le repli)
    return { ok: false, people };
  }
}

/**
 * Extrait les personnes d'une liste d'items {id, text}. L'`id` (URL de profil)
 * sert de clé de remappage et de clé de déduplication côté appelant. Les items
 * déjà vus (même texte) sortent du cache ; les autres partent par lots à Haiku,
 * et chaque résultat (y compris « rien ») est mis en cache.
 */
export async function extractPeople(
  items: Array<{ id: string; text: string }>
): Promise<Map<string, ExtractedPerson>> {
  const out = new Map<string, ExtractedPerson>();
  if (!hasExtractor() || !items.length) return out;

  const todo: Array<{ id: string; text: string }> = [];
  for (const it of items) {
    if (!it.text) continue;
    const hit = cacheGet.get(textKey(it.text)) as { person: string } | undefined;
    if (hit) {
      const e = JSON.parse(hit.person) as ExtractedPerson | null;
      if (e) out.set(it.id, { ...e, id: it.id });
      continue;
    }
    todo.push(it);
  }

  for (let i = 0; i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const { ok, people } = await callApi(chunk);
    for (const it of chunk) {
      const e = people.get(it.id) ?? null;
      // on ne mémorise (succès comme « rien à extraire ») qu'après un appel abouti :
      // un échec transitoire ne doit pas geler ces snippets pour les reruns.
      if (ok) cachePut.run(textKey(it.text), JSON.stringify(e), Date.now());
      if (e) out.set(it.id, e);
    }
  }
  return out;
}

/**
 * Tri des offres collectées : on ne garde que les postes tech (dev, data / ML,
 * devops) situés en France. Heuristiques sur l'intitulé, le service et le lieu :
 * gratuit, déterministe, et suffisant sur des intitulés d'ATS.
 */

export type JobCategory = "dev" | "data_ml" | "devops";

const norm = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

// Villes et zones qui suffisent à situer une offre en France quand le pays n'est pas donné.
const FR_PLACES =
  /\b(france|paris|lyon|marseille|toulouse|nantes|bordeaux|lille|rennes|strasbourg|montpellier|grenoble|nice|sophia[- ]antipolis|ile[- ]de[- ]france|idf|rouen|nancy|clermont[- ]ferrand|tours|angers|dijon|brest|aix[- ]en[- ]provence|levallois|boulogne[- ]billancourt|nanterre|la defense|courbevoie|puteaux|issy[- ]les[- ]moulineaux|montreuil|saint[- ]denis|massy|saclay|versailles|villeurbanne|caen|orleans|reims|le mans|metz|annecy|pau|niort|limoges|saint[- ]etienne|toulon|le havre|amiens|besancon|poitiers|la rochelle|lannion|valbonne|neuilly[- ]sur[- ]seine|saint[- ]ouen|clichy|ivry[- ]sur[- ]seine|pantin)\b/;

/** L'offre est-elle (au moins en partie) localisée en France ? */
export function isInFrance(location: string | null, country: string | null): boolean {
  const c = norm(country ?? "").trim();
  if (c === "fr" || c === "fra" || c === "france") return true;
  return FR_PLACES.test(norm(location ?? ""));
}

// Métiers non techniques dont l'intitulé contient souvent un mot tech (« Sales
// Engineer », « Account Executive, AI »…) : ils l'emportent sur tout le reste.
const NON_TECH =
  /\b(sales|account (executive|manager|director)|commercial|commerciale|marketing|marketer|recruiter|recruteur|recruteuse|talent|customer success|csm|business dev\w*|biz ?dev|bdr|sdr|juriste|legal|comptable|accountant|payroll|office manager|assistant|assistante|partnerships?|avant[- ]vente|pre[- ]?sales|solutions? (engineer|consultant|architect)|support|ingenieur (d'affaires|commercial)|charge d'affaires|people (partner|ops|operations)|product (manager|owner|designer|marketing)|chef de produit|designer)\b/;

const DATA_ML =
  /\b(machine learning|ml|mlops|llm|nlp|deep learning|computer vision|genai|data science|data (scientist|engineer|analyst|architect|ingenieur)|(ingenieur|engineer|scientist|architecte|analyste|developpeur) (data|ia|ai|ml)|analytics engineer|research (engineer|scientist)|applied scientist|ai (engineer|researcher|scientist)|head of (ai|data))\b/;

const DEVOPS =
  /\b(devops|devsecops|sre|site reliability|platform engineer|infrastructure|cloud (engineer|architect)|ingenieur (cloud|systeme|systemes|reseau|reseaux|infrastructure|securite)|kubernetes|security engineer|secops|sysadmin|administrateur system\w*)\b/;

const DEV =
  /\b(developer|developpeur|developpeuse|dev|software|frontend|front[- ]end|backend|back[- ]end|full[- ]?stack|ios|android|mobile (engineer|developer)|tech lead|lead (tech|dev)|engineering manager|cto|vp engineering|head of engineering|qa engineer|sdet|embedded|embarque|firmware|programmer|programmeur|ingenieur (logiciel|etudes|developpement)|python|java|javascript|typescript|react|node\.?js|golang|rust|php|ruby|scala|kotlin|swift)\b/;
// langages dont le nom contient un symbole (\b ne s'y applique pas)
const DEV_SYMBOLS = /(^|[^a-z])(c\+\+|c#|\.net)([^a-z]|$)/;

// « Engineer » seul ne suffit pas (mécanique, génie civil…) : il faut un service tech.
const GENERIC_ENGINEER = /\b(engineer|ingenieur|ingenieure|engineering)\b/;
const TECH_DEPARTMENT = /\b(engineering|tech|technology|technologie|software|r&d|data|it|informatique)\b/;

/** Catégorie tech d'une offre, ou null si le poste n'est pas un poste tech. */
export function techCategory(title: string, department: string | null): JobCategory | null {
  const t = norm(title);
  if (NON_TECH.test(t)) return null;
  if (DATA_ML.test(t)) return "data_ml";
  if (DEVOPS.test(t)) return "devops";
  if (DEV.test(t) || DEV_SYMBOLS.test(t)) return "dev";
  if (GENERIC_ENGINEER.test(t) && TECH_DEPARTMENT.test(norm(department ?? ""))) return "dev";
  return null;
}

// « Apprentissage » seul désigne le contrat ; suivi d'un qualificatif, c'est du machine learning.
const ALTERNANCE =
  /\b(alternan\w+|apprentie?s?|apprentice(ship)?s?|contrat (de )?pro(fessionnalisation)?|work[- ]study|apprentissage(?! (automatique|profond|machine|statistique|supervise|non supervise|par renforcement|federe)))\b/;

/** L'intitulé annonce-t-il une alternance (contrat d'apprentissage ou de professionnalisation) ? */
export function isAlternance(title: string): boolean {
  return ALTERNANCE.test(norm(title));
}

// Stages, thèses, VIE : avec l'alternance, les postes qu'on ne pourvoit pas en allant chercher un ingénieur en poste.
const TRAINEE = /\b(stage|stagiaire|intern|internship|these|cifre|phd|doctorant\w*|summer|graduate program)\b/;
const VIE = /\bV\.?I\.?E\b/; // sur l'intitulé tel quel : en minuscules, « vie » est un mot courant

/** L'intitulé annonce-t-il un poste d'apprenant (alternance, stage, thèse, VIE) ? */
export function isTrainee(title: string): boolean {
  return isAlternance(title) || TRAINEE.test(norm(title)) || VIE.test(title);
}

const LEADERSHIP = /\b(cto|chief|head of|vp|vice[- ]president|directeur|directrice|director|manager|responsable)\b/;

/** L'intitulé est-il celui d'un poste de direction ou d'encadrement (« Head of Data », « Engineering Manager ») ? */
export function isLeadership(title: string): boolean {
  return LEADERSHIP.test(norm(title));
}

// Mention de genre d'un intitulé : « H/F », « (F/H/X) », « - h/f/nb », « (m/w/d) », « (H-F) », « H/F*** »…
// avec le séparateur qui la précède. Sans parenthèses, seuls la barre oblique et « H-F » sont reconnus.
const GENDER = "(?:nb|mx|[hfmxndw])";
const GENDER_MARK = new RegExp(
  `[\\s\\-–—|,:]*(?:[(\\[]\\s*${GENDER}(?:\\s*[/\\-|]\\s*${GENDER}){1,3}\\s*\\**\\s*[)\\]]?` +
    `|(?<![\\p{L}\\d/])${GENDER}(?:\\s*/\\s*${GENDER}){1,3}(?![\\p{L}\\d/])` +
    `|(?<![\\p{L}\\d/-])(?:h-f|f-h)(?![\\p{L}\\d/-]))\\**`,
  "giu"
);

/** Intitulé sans mention de genre : « Développeur Python (H/F) - Lyon » → « Développeur Python - Lyon ». */
export function cleanTitle(title: string): string {
  const cleaned = title
    .replace(GENDER_MARK, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—|,:]+|[\s\-–—|,:]+$/g, "");
  return cleaned || title.trim();
}

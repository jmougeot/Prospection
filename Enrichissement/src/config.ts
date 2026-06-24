import "dotenv/config";

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  // Port distinct du mailer (3000) pour pouvoir lancer les deux apps en parallèle.
  port: int("PORT", 3100),
  baseUrl: process.env.BASE_URL ?? "http://localhost:3100",
  // Moteur de recherche pour la prospection (LinkedIn). Si une clé est présente,
  // l'API correspondante devient prioritaire ; sinon, repli sur le scraping HTML
  // de moteurs publics. Priorité : Google > Serper > Brave.
  search: {
    googleApiKey: process.env.GOOGLE_SEARCH_API_KEY ?? "",
    googleCx: process.env.GOOGLE_SEARCH_CX ?? "", // ID du moteur de recherche programmable
    serperApiKey: process.env.SERPER_API_KEY ?? "",
    braveApiKey: process.env.BRAVE_SEARCH_API_KEY ?? "",
  },
  // Extraction des champs prospect (nom, poste, entreprise, lieu) depuis les
  // résultats de recherche bruts via Claude Haiku. Sans clé, on retombe sur le
  // parsing heuristique (regex). Haiku 4.5 : ~$1/M entrée, ~$5/M sortie — soit
  // quelques centimes pour un lot complet (cf. cache d'extraction).
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5",
  },
};

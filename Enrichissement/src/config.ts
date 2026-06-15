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
};

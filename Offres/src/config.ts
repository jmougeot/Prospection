import "dotenv/config";
import { fileURLToPath } from "node:url";

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  // Port distinct du mailer (3000) et de l'enrichissement (3100) : les trois apps tournent en parallèle.
  port: int("PORT", 3200),
  baseUrl: process.env.BASE_URL ?? "http://localhost:3200",
  // Sert uniquement à DÉCOUVRIR de nouvelles pages carrières (requêtes site:…).
  // Sans clé, la collecte fonctionne quand même sur les pages ajoutées à la main.
  serperApiKey: process.env.SERPER_API_KEY ?? "",
  // Lecture des pages carrières « maison » par des sessions Claude Code sans interface
  // (abonnement de la machine, aucune clé d'API).
  claudeBin: process.env.CLAUDE_BIN ?? "claude",
  claudeModel: process.env.CLAUDE_MODEL ?? "opus",
  // Base d'entreprises d'Enrichissement, lue seule, pour savoir quels sites visiter.
  enrichissementDb:
    process.env.ENRICHISSEMENT_DB ?? fileURLToPath(new URL("../../Enrichissement/data/enrichissement.db", import.meta.url)),
};

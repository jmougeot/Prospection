import express from "express";
import { fileURLToPath } from "node:url";
import { registerB2bRoutes } from "./services/b2b/routes.js";

export function createServer(): express.Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(express.text({ type: ["text/csv", "text/plain"], limit: "20mb" }));
  // Relatif au projet, pas au répertoire de lancement
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

  // Moteur de recherche / prospection
  registerB2bRoutes(app);

  return app;
}

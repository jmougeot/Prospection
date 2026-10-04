import express from "express";
import { fileURLToPath } from "node:url";
import { registerRoutes } from "./routes.js";

export function createServer(): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  // Relatif au projet, pas au répertoire de lancement
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

  registerRoutes(app);

  return app;
}

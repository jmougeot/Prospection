import { config } from "./config.js";
import { createServer } from "./server.js";

const app = createServer();
app.listen(config.port, () => {
  console.log(`Enrichissement — prospection sur ${config.baseUrl}`);
});

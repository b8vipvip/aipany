import "dotenv/config";

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { ProviderConfigRepository } from "./modules/providers/provider-config.repository.js";
import { ProviderConfigService } from "./modules/providers/provider-config.service.js";
import { SecretCrypto } from "./security/secret-crypto.js";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);

await runMigrations(db);

const providers = new ProviderConfigService(
  new ProviderConfigRepository(db),
  new SecretCrypto(config.AIPANY_CONFIG_ENCRYPTION_KEY),
);

await buildApp(config, providers).listen({
  host: config.ADMIN_API_HOST,
  port: config.ADMIN_API_PORT,
});

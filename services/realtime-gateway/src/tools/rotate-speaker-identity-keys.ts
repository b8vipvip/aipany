import { KeyringPostgresSpeakerIdentityStore } from "@aipany/audio-intelligence";
import { loadConfig } from "../config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.speakerIdentity.store !== "postgres") {
    throw new Error("speaker:rotate-keys 仅适用于 SPEAKER_IDENTITY_STORE=postgres");
  }
  const connectionString = config.speakerIdentity.connectionString;
  const encryptionKey = config.speakerIdentity.encryptionKey;
  if (!connectionString || !encryptionKey) {
    throw new Error("缺少 DATABASE_URL 或 SPEAKER_IDENTITY_ENCRYPTION_KEY");
  }

  const store = new KeyringPostgresSpeakerIdentityStore({
    connectionString,
    encryptionKey,
    ssl: config.speakerIdentity.databaseSsl,
    maxPoolSize: Math.max(1, Math.min(4, config.speakerIdentity.poolMax)),
    matchCandidateCount: config.speakerIdentity.matchCandidates,
  });

  try {
    const result = await store.rotateAllEncryptedEmbeddings();
    console.log(`[aipany] Speaker Identity key rotation completed: profiles=${result.profiles}, samples=${result.samples}`);
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error("[aipany] Speaker Identity key rotation failed:", error);
  process.exitCode = 1;
});

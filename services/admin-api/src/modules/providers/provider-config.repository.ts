import type { DbClient } from "../../db/client.js";
import type { ProviderConfigRow, ProviderPolicy } from "./provider-config.types.js";

export class ProviderConfigRepository {
  constructor(private readonly db: DbClient) {}

  async list(): Promise<ProviderConfigRow[]> {
    const result = await this.db.query("SELECT * FROM provider_configs ORDER BY category, priority, name");
    return result.rows as ProviderConfigRow[];
  }

  async get(id: string): Promise<ProviderConfigRow | null> {
    const result = await this.db.query("SELECT * FROM provider_configs WHERE id=$1", [id]);
    return (result.rows[0] as ProviderConfigRow | undefined) ?? null;
  }

  async create(value: Partial<ProviderConfigRow>): Promise<ProviderConfigRow> {
    const result = await this.db.query(
      `INSERT INTO provider_configs (
        name, category, protocol, enabled, base_url, model, voice,
        api_key_ciphertext, api_key_iv, api_key_auth_tag, priority, settings
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        value.name,
        value.category,
        value.protocol,
        value.enabled,
        value.base_url,
        value.model,
        value.voice,
        value.api_key_ciphertext,
        value.api_key_iv,
        value.api_key_auth_tag,
        value.priority,
        JSON.stringify(value.settings ?? {}),
      ],
    );

    return result.rows[0] as ProviderConfigRow;
  }

  async update(id: string, value: Partial<ProviderConfigRow>): Promise<ProviderConfigRow | null> {
    const result = await this.db.query(
      `UPDATE provider_configs SET
        name=COALESCE($2,name),
        category=COALESCE($3,category),
        protocol=COALESCE($4,protocol),
        enabled=COALESCE($5,enabled),
        base_url=COALESCE($6,base_url),
        model=COALESCE($7,model),
        voice=CASE WHEN $8::boolean THEN $9 ELSE voice END,
        api_key_ciphertext=COALESCE($10,api_key_ciphertext),
        api_key_iv=COALESCE($11,api_key_iv),
        api_key_auth_tag=COALESCE($12,api_key_auth_tag),
        priority=COALESCE($13,priority),
        settings=COALESCE($14,settings),
        updated_at=now()
      WHERE id=$1 RETURNING *`,
      [
        id,
        value.name,
        value.category,
        value.protocol,
        value.enabled,
        value.base_url,
        value.model,
        Object.prototype.hasOwnProperty.call(value, "voice"),
        value.voice,
        value.api_key_ciphertext,
        value.api_key_iv,
        value.api_key_auth_tag,
        value.priority,
        value.settings ? JSON.stringify(value.settings) : null,
      ],
    );

    return (result.rows[0] as ProviderConfigRow | undefined) ?? null;
  }

  async delete(id: string): Promise<void> {
    await this.db.query("DELETE FROM provider_configs WHERE id=$1", [id]);
  }

  async getPolicy(): Promise<ProviderPolicy> {
    const result = await this.db.query("SELECT value FROM system_settings WHERE key='provider_policy'");
    const row = result.rows[0] as { value?: ProviderPolicy } | undefined;
    return row?.value ?? {};
  }

  async setPolicy(policy: ProviderPolicy): Promise<ProviderPolicy> {
    await this.db.query(
      "INSERT INTO system_settings (key,value) VALUES ('provider_policy',$1) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()",
      [JSON.stringify(policy)],
    );
    return policy;
  }
}

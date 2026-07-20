# Aipany Speaker Identity Persistence v0.2.2

## 目标

让 Aipany 学到的“主人、家人、朋友”可以：

- 跨 WebSocket 会话复用；
- 跨 Gateway 重启保留；
- 多 Gateway 实例共享；
- 按 tenant/user 严格做数据访问作用域；
- 支持删除人物和长期声纹；
- 不把 canonical Speaker Embedding 明文写入数据库。

## Store 抽象

业务层只依赖：

```text
SpeakerIdentityStore
```

当前实现：

```text
InMemorySpeakerIdentityStore
PostgresSpeakerIdentityStore
```

Realtime Gateway 不直接在会话逻辑里写 SQL。

## 数据库

Docker Compose 使用：

```text
pgvector/pgvector:pg16
```

初始化迁移：

```text
deploy/postgres/init/001_speaker_identity.sql
```

全新数据卷会自动运行该脚本。已有数据库需要由部署流程显式执行迁移。

## 加密模型

### Canonical embeddings

以下字段应用层加密后以 `BYTEA` 保存：

- `speaker_profiles.centroid_encrypted`
- `speaker_samples.encrypted_embedding`

算法：

```text
AES-256-GCM
```

每条密文使用随机 96-bit IV，并带认证 Tag。

AAD 包含：

- tenantId
- userId
- profileId
- sampleId（样本时）
- 数据用途标识

因此密文不能被简单复制到另一个人物或租户上下文中继续正常解密。

### pgvector search projection

为了避免把 canonical embedding 明文写入 pgvector，数据库只保存密钥派生的正交搜索投影。

当前变换为按作用域派生的 signed permutation：

- 保持向量维度；
- 保持 cosine similarity；
- 不同 tenant/user 使用不同投影；
- 用于候选召回，不作为最终身份确认结果。

最终 `identify()` 会解密候选的 centroid 和 samples，再执行领域层的精确多样本评分。

重要：搜索投影仍然保留同一作用域内的相似性结构，属于敏感派生数据，必须继续按生物识别数据保护。

## 识别流程

```text
Current Embedding
↓
按 tenant/user 投影
↓
pgvector cosine candidate retrieval
↓
最多 N 个候选 Profile
↓
AES-GCM 解密候选 centroid / samples
↓
Top-3 sample similarity + centroid similarity
↓
Profile status + match threshold
↓
SpeakerMatch
```

默认候选数量：

```text
SPEAKER_IDENTITY_MATCH_CANDIDATES=20
```

当前 `vector` 列允许不同 embedding 维度，因此 v0.2.2 没有直接建立固定维度 HNSW 索引。

当生产模型维度稳定后，可以按模型/维度拆分索引或增加固定维度向量列，再建立 HNSW/IVFFlat。

## 多租户作用域

所有 Store 操作都要求：

```text
SpeakerIdentityScope {
  tenantId
  userId
}
```

数据库查询同时限制：

```sql
tenant_id = ? AND user_id = ?
```

删除、人物读取、样本写入和身份识别都不能只通过 `personId` 绕过作用域。

当前限制：`tenantId/userId` 来自会话协议，Gateway 仍使用共享 Token 为主。正式 SaaS 部署必须由认证层提供可信 claims，不能把客户端自报字段当成完整授权机制。

## 删除

协议：

```json
{
  "type": "speaker.identity.delete",
  "personId": "..."
}
```

成功：

```json
{
  "type": "speaker.identity.deleted",
  "personId": "..."
}
```

数据库：

```text
persons
  ON DELETE CASCADE
    speaker_profiles
      ON DELETE CASCADE
        speaker_samples
```

## 配置

```text
SPEAKER_IDENTITY_STORE=postgres
DATABASE_URL=postgresql://...
SPEAKER_IDENTITY_ENCRYPTION_KEY=<32-byte base64 or 64-char hex>
SPEAKER_IDENTITY_DATABASE_SSL=false
SPEAKER_IDENTITY_DB_POOL_MAX=10
SPEAKER_IDENTITY_MATCH_CANDIDATES=20
```

生成开发/部署密钥示例：

```bash
openssl rand -base64 32
```

生产环境必须通过 Secret Manager、KMS 或等价设施注入，不应提交到 Git。

## 当前风险和后续工作

### 1. IAM 仍需加强

Store 层已经隔离作用域，但 Gateway 还需要真正的用户/设备认证，把 tenant/user claims 和凭证绑定。

### 2. Key rotation 未实现

当前密文 envelope 有格式版本，但还没有 key ID 和多版本 keyring。

下一版持久化安全增强应支持：

- active key；
- previous keys；
- lazy re-encryption；
- 批量 key rotation job。

### 3. 审计日志未实现

后续应记录：

- enrollment consent；
- profile create；
- sample append；
- identity delete；
- 管理员数据导出/删除操作。

### 4. Search projection 仍是敏感模板

即使不是 canonical embedding，它仍可用于同一作用域内相似性比较，因此数据库访问权限、备份、日志和导出都必须继续严格限制。

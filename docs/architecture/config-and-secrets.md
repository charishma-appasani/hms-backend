# Config & Secrets

> How configuration and database credentials are managed across local and deployed
> environments. Stack: NestJS + Prisma (driver adapter `@prisma/adapter-pg`) on ECS.

## Principle: the app only reads from the environment

The application never knows *where* config came from — it reads `process.env` (validated
via `@nestjs/config` + zod, see [`src/config/env.schema.ts`](../../src/config/env.schema.ts)).
Only the **source** of those env vars differs per environment:

| Environment | Source of env vars |
|---|---|
| Local dev | `.env` file (gitignored); `.env.example` is the committed template |
| dev / staging / prod (ECS) | **AWS Secrets Manager**, injected into the container by the ECS task definition |

This is what keeps local and prod identical in code (12-factor).

## Local

1. `cp .env.example .env` and fill in `DATABASE_URL`.
2. `prisma.config.ts` loads `.env` (via `dotenv`) and feeds `DATABASE_URL` to Migrate;
   `@nestjs/config` loads it for the app; the runtime client connects via the
   `@prisma/adapter-pg` adapter built from the same `DATABASE_URL`.
   **Prisma 7 note:** the connection URL lives in `prisma.config.ts`, **not** in the schema's
   `datasource` block (which only declares `provider`).
3. Never commit `.env` (it's in `.gitignore`). Keep `.env.example` current.

Validation runs at boot — a missing/invalid `DATABASE_URL` fails fast with a readable error.

## ECS + Secrets Manager

Store the DB credential in Secrets Manager (one secret **per environment**, e.g.
`hms/prod/db`) and inject it into the container as an env var via the task definition —
**no SDK code in the app**:

```jsonc
// taskDefinition → containerDefinitions[].secrets
"secrets": [
  { "name": "DATABASE_URL", "valueFrom": "arn:aws:secretsmanager:<region>:<acct>:secret:hms/prod/db-XXXX" }
]
```

Requirements:
- The **task execution role** needs `secretsmanager:GetSecretValue` (+ `kms:Decrypt` if the
  secret uses a customer-managed KMS key).
- If RDS manages the secret, it's JSON (`{username,password,host,port,dbname}`). Either
  inject a single key (`valueFrom: "...:password::"`) and assemble the URL at startup, or
  keep a separate full-connection-string secret (simplest for Prisma).
- SSM Parameter Store `SecureString` works the same way and is cheaper for non-rotating
  config; Secrets Manager is preferred when you want managed rotation.

## Rotation gotcha

Env vars are set **once at container start**. If the DB password rotates, a *running* task
keeps the old value until it restarts. Handle it by:
- **Simple:** trigger a rolling ECS deployment on rotation.
- **Prod hardening (later):** **RDS Proxy + IAM auth** — the app uses a short-lived IAM
  token instead of a stored password, so there's nothing to rotate. More setup (Prisma must
  receive the token as the connection password and refresh it); treat as a follow-up.

## Migrations

Run `prisma migrate deploy` (not `migrate dev`) as a **separate one-off step** — a CI/CD
stage or `aws ecs run-task` — with the same `DATABASE_URL` secret injected. Do **not** run
migrations from the long-running app container on boot.

## Adding a new config value

1. Add it to `envSchema` in `src/config/env.schema.ts` (with type + default if optional).
2. Add it to `.env.example`.
3. For deployed envs, add it to the secret/parameter and the task definition.

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

## Database: components, not a URL

The app reads **discrete DB components** — `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_USER`,
`DATABASE_PASSWORD`, `DATABASE_NAME` — and assembles the connection string itself via
`buildDatabaseUrl` in [`env.schema.ts`](../../src/config/env.schema.ts) (with `?sslmode=require`).
This lets deployed environments inject the credentials **straight from the RDS-managed secret**,
so there is **no separate full-URL secret to hand-populate** and password rotation is tracked.

Both the runtime adapter ([`prisma.service.ts`](../../src/prisma/prisma.service.ts)) and the
Migrate CLI ([`prisma.config.ts`](../../prisma.config.ts)) build the URL from the same components.
**Prisma 7 note:** the URL lives in `prisma.config.ts`, **not** the schema's `datasource` block
(which only declares `provider`).

## Local

1. `cp .env.example .env` and fill in the `DATABASE_*` components.
2. `@nestjs/config` validates them at boot (a missing/invalid value fails fast); `prisma.config.ts`
   loads them via `dotenv` for Migrate. Never commit `.env`; keep `.env.example` current.

## ECS (injected from the RDS-managed secret)

CDK wires the task definition so credentials come from the RDS secret and the rest are plain env
vars — **no SDK code in the app, no secret to populate**:

```ts
// infrastructure/lib/infrastructure-stack.ts → taskDefinition.addContainer('hms', { ... })
environment: { DATABASE_HOST: database.instanceEndpoint.hostname, DATABASE_PORT: '5432', DATABASE_NAME: 'hms' },
secrets: {
  DATABASE_USER:     ecs.Secret.fromSecretsManager(database.secret!, 'username'),
  DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
}
```

`fromSecretsManager` auto-grants the execution role `GetSecretValue` (+ KMS decrypt) on the secret.

## Rotation

The app always sources the password from the live RDS-managed secret, so rotation is mostly
automatic — but env vars are read **once at task launch**, so a *running* task keeps the old value
until it restarts. Trigger a rolling deployment (`update-service --force-new-deployment`) on
rotation. **Prod hardening (later):** RDS Proxy + IAM auth removes the stored password entirely.

## Migrations

Run `prisma migrate deploy` (not `migrate dev`) as a **separate one-off step** — a CI/CD stage or
`aws ecs run-task` — with the same `DATABASE_*` components injected (same `environment` + `secrets`
as the app). Do **not** run migrations from the long-running app container on boot.

## Adding a new config value

1. Add it to `envSchema` in `src/config/env.schema.ts` (with type + default if optional).
2. Add it to `.env.example`.
3. For deployed envs, add it to the secret/parameter and the task definition.

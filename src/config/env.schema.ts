import { z } from 'zod';

/**
 * Single source of truth for environment configuration. Values come from `.env` locally and
 * from the ECS task definition (env + Secrets Manager) in deployed environments — the app does
 * not care which. Validation runs at boot so a missing/invalid var fails fast.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  // Database components. On ECS these are injected straight from the RDS-managed secret
  // (username/password/host/port/dbname); the connection string is assembled in code
  // (buildDatabaseUrl) so nothing needs a hand-populated secret. See config-and-secrets.md.
  DATABASE_HOST: z.string(),
  DATABASE_PORT: z.coerce.number().int().positive().default(5432),
  DATABASE_USER: z.string(),
  DATABASE_PASSWORD: z.string(),
  DATABASE_NAME: z.string().default('hms'),
  // TLS mode for the Postgres connection. `require` for RDS (rds.force_ssl=1); `disable` for a
  // local Postgres without SSL. Keep in sync with prisma.config.ts (the CLI assembles its own URL).
  DATABASE_SSLMODE: z.enum(['require', 'disable', 'prefer']).default('require'),
  // Cognito (single shared user pool for all users; see data-model.md)
  AWS_REGION: z.string().default('ap-south-2'),
  COGNITO_USER_POOL_ID: z.string(),
  COGNITO_CLIENT_ID: z.string(),
  // Notifications. Disabled by default → logging stubs (so local/CI never send). Set
  // NOTIFICATIONS_ENABLED=true in deployed envs to use real SES (email) + SNS (SMS).
  NOTIFICATIONS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  NOTIFICATIONS_EMAIL_FROM: z.email().optional(), // a verified SES sender identity
  SMS_SENDER_ID: z.string().optional(), // DLT-registered sender ID (India)
  SMS_DLT_ENTITY_ID: z.string().optional(), // DLT principal-entity ID (India)
});

export type Env = z.infer<typeof envSchema>;

/**
 * Assemble the Prisma/Postgres connection string from discrete components. `sslmode` defaults to
 * `require` (RDS enforces TLS via `rds.force_ssl=1`); set `disable` for a local Postgres without
 * SSL. The password is URL-encoded so special characters don't corrupt the URL.
 */
export function buildDatabaseUrl(p: {
  user: string;
  password: string;
  host: string;
  port: number;
  name: string;
  sslmode?: string;
}): string {
  return `postgresql://${p.user}:${encodeURIComponent(p.password)}@${p.host}:${p.port}/${p.name}?sslmode=${p.sslmode ?? 'require'}`;
}

/** Passed to `ConfigModule.forRoot({ validate })`. Throws with a readable message on failure. */
export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(
        (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return parsed.data;
}

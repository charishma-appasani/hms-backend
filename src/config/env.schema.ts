import { z } from 'zod';

/**
 * Single source of truth for environment configuration. Values come from `.env` locally and
 * from the ECS task definition (env + Secrets Manager) in deployed environments — the app does
 * not care which. Validation runs at boot so a missing/invalid var fails fast.
 */
export const envSchema = z
  .object({
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
    DATABASE_SSLMODE: z
      .enum(['require', 'disable', 'prefer'])
      .default('require'),
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
    // AI assist (see docs/architecture/ai-features.md). Disabled by default → deterministic stub
    // provider, so local/CI never call Bedrock. Set AI_ENABLED=true in deployed environments.
    AI_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // Inference region. Defaults to AWS_REGION; override when Anthropic models are not invocable
    // from the app's region (ap-south-2 → ap-south-1). Must stay in India for DPDP residency.
    BEDROCK_REGION: z.string().optional(),
    // The inference profile / model id for the visit summary. NO DEFAULT on purpose: ids are
    // region- and account-specific and change over time. Resolve the real value with
    // `aws bedrock list-inference-profiles --region <region>`. Use an `apac.` geographic profile,
    // never `global.` — a global profile may route PHI outside India.
    AI_SUMMARY_MODEL_ID: z.string().optional(),
    // Model for ask-this-chart Q&A. Optional — falls back to AI_SUMMARY_MODEL_ID when unset.
    AI_CHART_MODEL_ID: z.string().optional(),
    // Entity images (docs/architecture/asset-storage.md). Disabled by default → upload endpoints return
    // 503 and every image URL is null, so local/CI never touch S3. The buckets are created by the
    // CDK stack, which sets these in the task definition.
    IMAGES_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    // CDN-served, non-sensitive imagery (org logos, practice + medicine photos).
    PUBLIC_ASSETS_BUCKET: z.string().optional(),
    PUBLIC_ASSETS_CDN_DOMAIN: z.string().optional(),
    // Personal imagery (avatars, patient ID cards) — presigned reads only, never a CDN.
    PRIVATE_IMAGES_BUCKET: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // Fail at boot rather than at the first patient check-in.
    if (env.AI_ENABLED && !env.AI_SUMMARY_MODEL_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_SUMMARY_MODEL_ID'],
        message: 'is required when AI_ENABLED=true',
      });
    }
    // Same rule for images: a half-configured bucket set would fail at the first upload instead.
    if (env.IMAGES_ENABLED) {
      for (const key of [
        'PUBLIC_ASSETS_BUCKET',
        'PUBLIC_ASSETS_CDN_DOMAIN',
        'PRIVATE_IMAGES_BUCKET',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'is required when IMAGES_ENABLED=true',
          });
        }
      }
    }
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

# CI/CD & Deploy Auth

> How the container ships to ECS, how GitHub Actions authenticates to AWS without long-lived
> keys, and how the CDK stack outputs populate the deploy files. Files:
> [`.github/workflows/aws.yml`](../../.github/workflows/aws.yml),
> [`task-definition.json`](../../task-definition.json),
> [`infrastructure/lib/infrastructure-stack.ts`](../../infrastructure/lib/infrastructure-stack.ts).

## Pipeline

On push to `main`, [`aws.yml`](../../.github/workflows/aws.yml):

1. Assumes the AWS deploy role via **OIDC** (no stored keys).
2. Builds the `linux/arm64` image and pushes it to the `hms` ECR repo, tagged with the commit SHA.
3. Renders `task-definition.json` with that image, registers a new task-def revision, and rolls
   the **manually-created** ECS service (`wait-for-service-stability: true`).

CDK owns the foundation (VPC, ALB, target group, RDS, Cognito, ECR, IAM roles); the ECS
**service is created/updated outside CDK** and is what the workflow deploys to.

## OIDC auth (no long-lived keys)

GitHub Actions exchanges a short-lived OIDC token for temporary AWS credentials by assuming
`hms-github-deploy` (the `GithubDeployRole` in the stack). Nothing secret is stored in GitHub.

```
GitHub job (environment: production)
   │  OIDC token, sub = repo:charishma-appasani/hms-backend:environment:production
   ▼
AWS IAM OIDC provider (token.actions.githubusercontent.com)
   │  trust policy matches aud=sts.amazonaws.com AND the exact sub above
   ▼
hms-github-deploy role  → ECR push/pull, ECS register+update, iam:PassRole (task/exec roles)
```

**The `sub` claim is coupled to the workflow.** Because the job sets `environment: production`,
the token's `sub` is `repo:<owner>/<repo>:environment:production` — **not** `:ref:refs/heads/main`.
The role's trust condition must match exactly. If you remove `environment: production` from the
workflow (or rename the environment), update the trust condition in the stack or assumption fails
with `Not authorized to perform sts:AssumeRoleWithWebIdentity`.

### One-time setup

1. `cdk deploy` to create the OIDC provider + role.
2. GitHub → **Settings → Environments** → create `production` (add protection rules if desired).
3. GitHub → **Settings → Secrets and variables → Actions → Variables** → add variable
   `AWS_DEPLOY_ROLE_ARN` = the `GithubDeployRoleArn` output. *(A variable, not a secret — the ARN
   isn't sensitive and access is gated by the trust policy.)*
4. Delete the old `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` GitHub secrets and deactivate
   that IAM user's access keys.

> **OIDC provider is account-global** — only one per AWS account for GitHub. If the account
> already has it, import it (`OpenIdConnectProvider.fromOpenIdConnectProviderArn`) instead of
> creating a new one, or `cdk deploy` fails with "provider already exists".

## Stack outputs → deploy files

Get them after a deploy:

```powershell
aws cloudformation describe-stacks --stack-name Hms-Backend --region ap-south-2 --query "Stacks[0].Outputs" --output table
```

| Placeholder / field | CDK output | Used in |
|---|---|---|
| `executionRoleArn` | `TaskExecutionRoleArn` | task-definition.json |
| `taskRoleArn` | `TaskRoleArn` | task-definition.json |
| container `image` | `RepositoryUri` (`:tag` set by the workflow) | task-definition.json |
| `COGNITO_USER_POOL_ID` | `UserPoolId` | task-definition.json |
| `COGNITO_CLIENT_ID` | `UserPoolClientId` | task-definition.json |
| `DATABASE_URL` secret `valueFrom` | `DatabaseUrlSecretArn` | task-definition.json |
| `ECS_CLUSTER` | `ClusterName` | aws.yml |
| `AWS_DEPLOY_ROLE_ARN` (repo variable) | `GithubDeployRoleArn` | aws.yml (OIDC) |
| `ECS_SERVICE` | *manual* — the service isn't owned by CDK | aws.yml |
| (assemble DATABASE_URL) | `DatabaseEndpoint`, `DbCredentialsSecretArn` | the secret value (below) |

## DATABASE_URL: secret, not committed

The app reads a single `DATABASE_URL` (see [config-and-secrets.md](./config-and-secrets.md) and
`env.schema.ts`). The task definition references it through the `secrets` block by **ARN**, so the
password never appears in the file or in git:

```jsonc
"secrets": [
  { "name": "DATABASE_URL", "valueFrom": "<DatabaseUrlSecretArn>" }
]
```

At task launch the ECS agent reads the secret (via the execution role's `GetSecretValue`) and
injects `DATABASE_URL` into the container — no AWS SDK code in the app.

Populate the secret value **once** after deploy (password from `DbCredentialsSecretArn`, host from
`DatabaseEndpoint`); this is a local CLI action, nothing is committed:

```powershell
aws secretsmanager put-secret-value --secret-id hms/dev/database-url --region ap-south-2 `
  --secret-string "postgresql://postgres:<pw>@<DatabaseEndpoint>:5432/hms?schema=public&sslmode=require"
```

`sslmode=require` is needed because RDS enforces TLS (`rds.force_ssl=1`).

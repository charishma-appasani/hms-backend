# Networking, DNS & TLS

> The AWS topology the HMS backend runs on, the DNS delegation chain for `aayufy.com`,
> and how the ALB's TLS certificate is issued and attached. Stack source:
> [`infrastructure/lib/infrastructure-stack.ts`](../../infrastructure/lib/infrastructure-stack.ts).
> Region: `ap-south-2` (Hyderabad — India data residency).

## AWS topology

CDK owns the durable foundation; the ECS **task definition and service are managed outside
CDK** and attach to the target group / IAM roles the stack exports as outputs.

```
Internet
   │  443 (HTTPS) / 80 (redirect)
   ▼
Application Load Balancer  ── public subnets, AlbSecurityGroup (80/443 from anyone)
   │  3000 (HTTP, ALB SG only)
   ▼
Fargate tasks (ECS)        ── public subnets, no NAT; FargateSecurityGroup
   │  5432 (Postgres, Fargate SG only)
   ▼
RDS PostgreSQL 17          ── isolated subnets, DBSecurityGroup, encrypted, RETAIN
```

| Concern | Resource | Notes |
|---|---|---|
| Image registry | ECR `hms` | scan-on-push, keep last 5 images, `DESTROY` |
| Network | VPC, 2 AZs, **0 NAT gateways** | public subnets for ALB+Fargate (cost), isolated for RDS; S3 gateway endpoint |
| Ingress | ALB (internet-facing) | only entry point; WAFv2 WebACL is a TODO |
| Compute | ECS Fargate | task def/service managed manually, registers IP targets to `EcsTargetGroup` |
| Database | RDS PostgreSQL 17, `t4g.micro` | `rds.force_ssl=1`, encrypted, 7-day backups, **RETAIN** |
| Documents | S3 + CloudFront (OAC) | `DESTROY` + autoDelete |
| Identity | Cognito user pool (shared) | roles live in our DB, not Cognito; **RETAIN** |

> **No NAT** means Fargate tasks sit in **public** subnets to pull images / reach AWS APIs.
> They are not reachable from the internet (the SG only allows 3000 from the ALB SG), but
> this is a deliberate cost trade-off — revisit private subnets + NAT before production.

## DNS delegation chain

`aayufy.com` is registered at **Squarespace**; only the apex zone's name servers are set
there. Everything below is delegated into Route 53, and the dev subdomain is further
delegated into a **separate account** so the dev team can manage it independently.

```
Squarespace (registrar)
   │  NS → prod Route 53 name servers
   ▼
Route 53 zone: aayufy.com           (PROD account)
   │  NS record "dev" → dev Route 53 name servers
   ▼
Route 53 zone: dev.aayufy.com       (DEV account 201063584490)
   │  records: ACM validation CNAME, app ALIAS (api.dev.aayufy.com → ALB)
   ▼
ACM cert *.dev.aayufy.com           (DEV account, ap-south-2)
```

**The critical invariant:** the `dev` NS record in the prod `aayufy.com` zone must list the
*exact* four name servers of the dev account's `dev.aayufy.com` hosted zone. Route 53 assigns
new name servers whenever a hosted zone is **deleted and recreated** — if that happens and the
prod `dev` record isn't updated, the entire `dev.aayufy.com` subtree silently stops resolving
publicly (and every ACM validation / DNS record under it breaks).

Verify the live chain against a public resolver (not an internal/cached one):

```powershell
Resolve-DnsName -Type NS dev.aayufy.com -Server 8.8.8.8
# → must match the NS set on the dev account's dev.aayufy.com hosted zone
```

## TLS / ACM certificate

The ALB needs an ACM cert **in the same region** (`ap-south-2`) — unlike CloudFront, which
requires `us-east-1`. The cert covers `*.dev.aayufy.com`.

### Wildcard scope

`*.dev.aayufy.com` matches exactly one label below `dev.aayufy.com`:

- ✅ `api.dev.aayufy.com`, `hms.dev.aayufy.com`
- ❌ `dev.aayufy.com` (the apex itself)
- ❌ `a.b.dev.aayufy.com` (two labels)

Pick a single-label host (e.g. `api.dev.aayufy.com`) for the ALB.

### Recommended: let CDK issue & validate the cert

Because the `dev.aayufy.com` zone, the cert, and the ALB are all in the **same account and
region**, CDK can create the cert, write the validation CNAME into the zone, and wait for
`ISSUED` — removing all manual record entry:

```ts
const zone = route53.HostedZone.fromLookup(this, 'DevZone', {
  domainName: 'dev.aayufy.com',
});
const certificate = new acm.Certificate(this, 'Certificate', {
  domainName: '*.dev.aayufy.com',
  validation: acm.CertificateValidation.fromDns(zone),
});
```

Then point a hostname at the ALB (otherwise clients hit the raw `*.elb.amazonaws.com` name,
which the cert does not cover → TLS warnings):

```ts
new route53.ARecord(this, 'AlbAlias', {
  zone,
  recordName: 'api', // api.dev.aayufy.com
  target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb)),
});
```

### If issuing the cert manually (current approach)

Pass the ARN at deploy time; without it the ALB serves **HTTP on :80 only**:

```powershell
npx cdk deploy -c certificateArn=arn:aws:acm:ap-south-2:201063584490:certificate/...
```

The cert must be `ISSUED` **before** deploy — an ALB listener will not attach a
`PENDING_VALIDATION` cert (it fails with *"must have a fully-qualified domain name, a
supported signature, and a supported key size"*).

## Troubleshooting a stuck (`PENDING_VALIDATION`) cert

ACM polls **public** DNS for the validation CNAME and issues within minutes once it resolves.
If it's stuck, work the chain top-down:

1. **Get the expected record + per-domain status:**
   ```powershell
   aws acm describe-certificate --certificate-arn <arn> --region ap-south-2 --query "Certificate.{Status:Status,Domains:DomainValidationOptions[].{Name:DomainName,State:ValidationStatus,Record:ResourceRecord}}"
   ```
2. **Delegation live?** `Resolve-DnsName -Type NS dev.aayufy.com -Server 8.8.8.8` — must match
   the dev zone's NS. Mismatch ⇒ fix the `dev` NS record in the prod `aayufy.com` zone. *(Most
   common cause.)*
3. **Validation CNAME resolves?** `Resolve-DnsName -Type CNAME _<hash>.dev.aayufy.com -Server 8.8.8.8`
   — must return the `…acm-validations.aws` value. Resolves only after step 2 passes.
4. **Auto-append trap:** inside the `dev.aayufy.com` zone, enter only the label left of
   `.dev.aayufy.com`; Route 53 appends the zone name. Pasting the full name yields
   `_<hash>.dev.aayufy.com.dev.aayufy.com`.
5. **Multi-SAN:** every domain on the cert needs its own CNAME; one missing keeps all pending.
6. **CAA:** `Resolve-DnsName -Type CAA aayufy.com -Server 8.8.8.8` — if a CAA record exists it
   must authorize `amazon.com`.

## Teardown gotcha (RDS RETAIN)

RDS is `RemovalPolicy.RETAIN`, so a stack delete/rollback **orphans** the DB instance — which
then blocks deletion of its parameter group, security group, and subnet ("…has a dependent
object" / "…still members of this parameter group"). To unstick a `DELETE_FAILED` /
`UPDATE_ROLLBACK_FAILED` stack, delete the orphaned DB instance first, then retry. During the
build-out phase (no real patient data yet) consider `DESTROY` so failed deploys self-clean;
flip back to `RETAIN` + `deletionProtection: true` before production. See line-125 comment in
the stack.

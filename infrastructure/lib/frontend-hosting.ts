import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface FrontendHostingProps {
  /**
   * Shared GitHub Actions OIDC provider (one per account). Passed in from the parent stack so the
   * SPA deploy role hangs off the same provider as the backend role — no duplicate, no cross-stack
   * reference (this is a construct inside the same stack).
   */
  githubOidcProvider: iam.IOpenIdConnectProvider;
  /**
   * Custom domain the SPA is served from, e.g. `dev.aayufy.com`. The app derives its API host as
   * `api.` + this hostname (hms-frontend/src/app/core/config/api-base.ts), so this MUST be set for a
   * working deploy — on the raw *.cloudfront.net domain the app cannot reach its backend. Required
   * together with `certificateArn`.
   */
  domainName?: string;
  /**
   * ACM certificate ARN covering `domainName`. CloudFront only accepts certificates in **us-east-1**
   * (unlike the backend ALB cert, which lives in the app region), so this must be a us-east-1 cert.
   */
  certificateArn?: string;
}

/**
 * Frontend hosting for the Angular SPA: private (OAC-locked) S3 bucket behind CloudFront, plus the
 * GitHub Actions deploy role. A component of the single `Hms` stack — the frontend repo keeps only
 * its build/deploy workflow (hms-frontend/.github/workflows/deploy.yml), which reads this stack's
 * outputs at deploy time.
 */
export class FrontendHosting extends Construct {
  constructor(scope: Construct, id: string, props: FrontendHostingProps) {
    super(scope, id);

    const { githubOidcProvider, domainName, certificateArn } = props;
    if (Boolean(domainName) !== Boolean(certificateArn)) {
      throw new Error(
        'frontend domainName and certificateArn must be provided together (custom domain needs both an alias and a us-east-1 ACM cert).',
      );
    }
    const certificate = certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'Certificate', certificateArn)
      : undefined;

    const bucket = new s3.Bucket(this, 'HmsBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // Baseline security headers for a browser SPA (HSTS, no-sniff, clickjacking, referrer).
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    });

    const distribution = new cloudfront.Distribution(this, 'HmsCdn', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        compress: true,
      },
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      // Custom domain (only when a domain + us-east-1 cert are supplied at deploy time).
      domainNames: domainName ? [domainName] : undefined,
      certificate,
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
      ],
    });

    // ──────────────── GitHub Actions OIDC deploy role ────────────────
    // Trust matches the frontend workflow's `environment: production`, so the OIDC token `sub` is
    // `repo:<owner>/<repo>:environment:production`. Create the `production` environment in the
    // hms-frontend repo's Settings → Environments.
    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: 'hms-frontend-github-deploy',
      description:
        'Assumed by GitHub Actions (charishma-appasani/hms-frontend, env: production) to deploy the SPA.',
      assumedBy: new iam.OpenIdConnectPrincipal(githubOidcProvider, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub':
            'repo:charishma-appasani/hms-frontend:environment:production',
        },
      }),
      maxSessionDuration: Duration.hours(1),
    });

    // S3: upload the built app (sync --delete → list/get/put/delete on the bucket + objects).
    bucket.grantReadWrite(deployRole);
    // CloudFront: invalidate the cache after each deploy.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
        resources: [distribution.distributionArn],
      }),
    );
    // CloudFormation: the workflow reads BucketName/DistributionId from the stack outputs.
    const stack = Stack.of(this);
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:DescribeStacks'],
        resources: [
          `arn:${stack.partition}:cloudformation:${stack.region}:${stack.account}:stack/${stack.stackName}/*`,
        ],
      }),
    );

    // ─── Stack outputs consumed by the frontend deploy workflow ───
    // overrideLogicalId keeps the OutputKeys stable (BucketName/DistributionId/...) even though this
    // is a nested construct — deploy.yml queries them by exact key.
    const out = (key: string, value: string, description: string) => {
      const o = new CfnOutput(this, key, { value, description });
      o.overrideLogicalId(key);
    };

    out(
      'CloudFrontURL',
      distribution.distributionDomainName,
      'CloudFront domain — point your DNS (domainName) at this via an alias/CNAME',
    );
    if (domainName) {
      out(
        'AppURL',
        `https://${domainName}`,
        'Public URL of the Angular app (after DNS is pointed at CloudFrontURL)',
      );
    }
    out('BucketName', bucket.bucketName, 'S3 bucket that hosts the built Angular app');
    out(
      'DistributionId',
      distribution.distributionId,
      'CloudFront distribution id (used for cache invalidation)',
    );
    out(
      'FrontendDeployRoleArn',
      deployRole.roleArn,
      'Set as the hms-frontend repo variable AWS_DEPLOY_ROLE_ARN',
    );
  }
}

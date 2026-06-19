import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface InfrastructureStackProps extends cdk.StackProps {
  /** ACM cert ARN in THIS region for HTTPS. If absent, the ALB serves HTTP on :80 only. */
  certificateArn?: string;
}

/**
 * Durable HMS infrastructure (one account/branch/pipeline per environment).
 * CDK owns everything end-to-end: the foundation (VPC/ALB/RDS/Cognito/ECR), the IAM roles, and
 * the ECS **task definition + service** (single source of truth — no task-definition.json). The
 * CI pipeline only builds/pushes the image to ECR `:latest` and rolls the service via
 * `aws ecs update-service --force-new-deployment`.
 */
export class InfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InfrastructureStackProps) {
    super(scope, id, props);

    const { certificateArn } = props;

    // ─────────────────────────── ECR ───────────────────────────
    const repository = new ecr.Repository(this, 'HMSRepository', {
      repositoryName: 'hms',
      removalPolicy: RemovalPolicy.DESTROY,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 5, description: 'Keep last 5 images' }],
    });

    // ─────────────────────────── VPC ───────────────────────────
    // Public subnets for the ALB + Fargate (no NAT, to stay cheap); isolated subnets for RDS.
    const vpc = new ec2.Vpc(this, 'HMSVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });

    const cluster = new ecs.Cluster(this, 'HMSCluster', {
      vpc,
      clusterName: 'hms-backend', // stable across accounts so the workflow needs no per-branch edit
      enableFargateCapacityProviders: true,
    });

    // ──────────────────── Security groups ────────────────────
    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      description: 'ALB - public 80/443',
      allowAllOutbound: true,
    });
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'HTTP',
    );
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS',
    );

    // The manual ECS service launches tasks into this SG.
    const fargateSecurityGroup = new ec2.SecurityGroup(
      this,
      'FargateSecurityGroup',
      { vpc, description: 'Fargate tasks', allowAllOutbound: true },
    );
    // Only the ALB may reach the app port — tasks are NOT open to the internet.
    fargateSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(3000),
      'App traffic from ALB only',
    );

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DBSecurityGroup', {
      vpc,
      description: 'RDS PostgreSQL',
      allowAllOutbound: false,
    });
    dbSecurityGroup.addIngressRule(
      fargateSecurityGroup,
      ec2.Port.tcp(5432),
      'PostgreSQL from Fargate tasks',
    );

    // ─────────────────────────── RDS ───────────────────────────
    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_17,
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO,
      ),
      multiAz: false, // TODO - switch to true when needed
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      securityGroups: [dbSecurityGroup],
      // Production-grade settings applied to ALL environments: RETAIN orphans the DB on stack
      // delete (patient data survives); deletionProtection blocks accidental deletion.
      removalPolicy: RemovalPolicy.RETAIN,
      deletionProtection: true,
      databaseName: 'hms',
      credentials: rds.Credentials.fromGeneratedSecret('postgres'),
      storageEncrypted: true, // PHI at rest
      backupRetention: Duration.days(7),
      preferredBackupWindow: '03:00-04:00',
      deleteAutomatedBackups: true,
      parameters: { 'rds.force_ssl': '1' }, // enforce TLS to the DB
    });

    // The task definition injects the DB connection straight from the RDS-managed secret
    // (username/password/host/port/dbname); the app assembles the URL (see env.schema.ts →
    // buildDatabaseUrl). No separate secret to hand-populate, and it tracks password rotation.

    // ──────────── S3 + CloudFront (patient documents/reports) ────────────
    const documentsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    const distribution = new cloudfront.Distribution(this, 'DocumentsCdn', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(documentsBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
    });

    // ─────────────────────── Cognito ───────────────────────
    // Single shared pool for ALL users. Roles live in our DB (staff.roles / platform_role),
    // NOT in Cognito — so no custom role attributes here.
    const userPool = new cognito.UserPool(this, 'HMSUserPool', {
      userPoolName: 'hms-users',
      selfSignUpEnabled: false,
      signInAliases: { email: true, phone: true }, // staff via email, patients via phone
      standardAttributes: {
        email: { required: true, mutable: true },
        phoneNumber: { required: false, mutable: true },
        givenName: { required: true, mutable: true }, // app_user.firstName
        familyName: { required: false, mutable: true }, // app_user.lastName is optional
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // RETAIN: losing the pool breaks every cognito_sub → app_user link and forces re-registration.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const userPoolClient = userPool.addClient('HMSUserPoolClient', {
      userPoolClientName: 'hms-app',
      authFlows: {
        adminUserPassword: true, // staff invite (AdminCreateUser)
        userPassword: true,
        userSrp: true,
        custom: true, // patient OTP custom-auth flow
      },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    // ─────────────── IAM roles (referenced by the manual task def) ───────────────
    const taskRole = new iam.Role(this, 'FargateTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    documentsBucket.grantReadWrite(taskRole);
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudfront:CreateInvalidation',
          'cloudfront:GetInvalidation',
          'cloudfront:ListInvalidations',
        ],
        resources: [distribution.distributionArn],
      }),
    );
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'], // scope to a verified identity ARN once it exists
      }),
    );
    // Staff invite / patient provisioning against the pool.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminUpdateUserAttributes',
          'cognito-idp:AdminDeleteUser',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminInitiateAuth',
          'cognito-idp:ListUsers',
        ],
        resources: [userPool.userPoolArn],
      }),
    );

    const taskExecutionRole = new iam.Role(this, 'FargateTaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'ECS agent / container runtime role.',
    });
    taskExecutionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        'service-role/AmazonECSTaskExecutionRolePolicy',
      ),
    );
    // (The task def's container injects DATABASE_URL via ecs.Secret.fromSecretsManager, which
    // grants this execution role read on the secret automatically — no explicit grant needed.)

    // ──────────────── GitHub Actions OIDC deploy role ────────────────
    // Lets the GitHub workflow assume a role via OIDC instead of long-lived access keys.
    // One OIDC provider per AWS account: if this account already has the GitHub provider,
    // swap the `new` below for:
    //   iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GithubOidcProvider', '<existing-arn>')
    const githubOidcProvider = new iam.OpenIdConnectProvider(
      this,
      'GithubOidcProvider',
      {
        url: 'https://token.actions.githubusercontent.com',
        clientIds: ['sts.amazonaws.com'],
      },
    );

    // The workflow runs with `environment: production`, so the OIDC token's `sub` claim is
    // `repo:<owner>/<repo>:environment:production` (NOT `:ref:refs/heads/main`). The trust
    // condition below must match that exactly. Create the `production` environment in the
    // repo's Settings → Environments.
    const githubDeployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: 'hms-github-deploy',
      description:
        'Assumed by GitHub Actions (charishma-appasani/hms-backend, env: production) to deploy ECS.',
      assumedBy: new iam.OpenIdConnectPrincipal(githubOidcProvider, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub':
            'repo:charishma-appasani/hms-backend:environment:production',
        },
      }),
      maxSessionDuration: Duration.hours(1),
    });

    // ECR: push/pull the hms image (grantPullPush also adds ecr:GetAuthorizationToken on *).
    repository.grantPullPush(githubDeployRole);
    // ECS: roll the service onto the new image (CDK owns the task def, so CI only needs this —
    // no RegisterTaskDefinition / PassRole).
    githubDeployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
        resources: ['*'],
      }),
    );

    // ──────────────── Application Load Balancer + target group ────────────────
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ServiceALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });
    // NOTE: attach an AWS WAFv2 WebACL to `alb` here for SQLi/XSS/rate-limit protection (PHI).

    // Target group for the Fargate service below (awsvpc → IP targets).
    const targetGroup = new elbv2.ApplicationTargetGroup(
      this,
      'EcsTargetGroup',
      {
        vpc,
        port: 3000,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        deregistrationDelay: Duration.seconds(15),
        healthCheck: {
          path: '/', // the app's @Public() health route
          healthyHttpCodes: '200',
          interval: Duration.seconds(30),
          timeout: Duration.seconds(5),
        },
      },
    );

    if (certificateArn) {
      const certificate = acm.Certificate.fromCertificateArn(
        this,
        'Certificate',
        certificateArn,
      );
      alb.addListener('HttpRedirect', {
        port: 80,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });
      alb.addListener('HttpsListener', {
        port: 443,
        certificates: [certificate],
        defaultTargetGroups: [targetGroup],
      });
    } else {
      // No cert yet — serve HTTP on :80 (add `-c certificateArn=...` later for HTTPS + redirect).
      alb.addListener('HttpListener', {
        port: 80,
        defaultTargetGroups: [targetGroup],
      });
    }

    // ──────────────── Fargate task definition + service ────────────────
    // CDK is the single source of truth for the task definition (no task-definition.json). The CI
    // pipeline only builds/pushes the image to ECR `:latest` and rolls the service with
    // `aws ecs update-service --force-new-deployment`, so it re-pulls `:latest` without changing
    // the task def or desiredCount — no drift.
    const logGroup = new logs.LogGroup(this, 'HmsLogGroup', {
      logGroupName: '/ecs/hms-backend',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
      taskRole,
      executionRole: taskExecutionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    taskDefinition.addContainer('hms', {
      image: ecs.ContainerImage.fromEcrRepository(repository, 'latest'),
      essential: true,
      portMappings: [{ containerPort: 3000 }],
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        AWS_REGION: this.region,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        // Non-secret DB connection details straight from the RDS instance.
        DATABASE_HOST: database.instanceEndpoint.hostname,
        DATABASE_PORT: '5432',
        DATABASE_NAME: 'hms',
      },
      // Only the credentials come from the RDS-managed secret; the app assembles the connection
      // string (buildDatabaseUrl). fromSecretsManager auto-grants the execution role read.
      secrets: {
        DATABASE_USER: ecs.Secret.fromSecretsManager(database.secret!, 'username'),
        DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(
          database.secret!,
          'password',
        ),
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'hms', logGroup }),
    });

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      serviceName: 'hms-backend-service', // matches ECS_SERVICE in aws.yml
      taskDefinition,
      // First-ever deploy only: ECR `:latest` doesn't exist yet, so the task can't start and the
      // circuit breaker would roll back. Bootstrap with `-c desiredCount=0`, push an image via the
      // pipeline, then redeploy at 1. Steady state is 1.
      desiredCount: Number(this.node.tryGetContext('desiredCount') ?? 0),
      assignPublicIp: true, // public subnets, no NAT — tasks need a public IP to reach ECR/AWS
      securityGroups: [fargateSecurityGroup],
      capacityProviderStrategies: [
        { capacityProvider: 'FARGATE_SPOT', weight: 1 },
      ],
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      circuitBreaker: { rollback: true },
      availabilityZoneRebalancing: ecs.AvailabilityZoneRebalancing.ENABLED,
      healthCheckGracePeriod: Duration.seconds(60),
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
    });

    // Listener → target group → this service (container/port match task-definition.json).
    targetGroup.addTarget(
      service.loadBalancerTarget({ containerName: 'hms', containerPort: 3000 }),
    );

    // ─────────────────────── Outputs (consumed by the manual task def + service) ───────────────────────
    new cdk.CfnOutput(this, 'AlbUrl', {
      value: `${certificateArn ? 'https' : 'http'}://${alb.loadBalancerDnsName}`,
    });
    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'ServiceName', { value: service.serviceName });
    new cdk.CfnOutput(this, 'TargetGroupArn', {
      value: targetGroup.targetGroupArn,
    });
    new cdk.CfnOutput(this, 'TaskRoleArn', { value: taskRole.roleArn });
    new cdk.CfnOutput(this, 'TaskExecutionRoleArn', {
      value: taskExecutionRole.roleArn,
    });
    new cdk.CfnOutput(this, 'FargateSecurityGroupId', {
      value: fargateSecurityGroup.securityGroupId,
    });
    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: vpc.publicSubnets.map((s) => s.subnetId).join(','),
    });
    new cdk.CfnOutput(this, 'RepositoryUri', {
      value: repository.repositoryUri,
    });
    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: database.instanceEndpoint.hostname,
    });
    // RDS-managed JSON secret ({username,password,host,port,dbname}) — the task definition
    // injects these fields directly into the container.
    new cdk.CfnOutput(this, 'DbCredentialsSecretArn', {
      value: database.secret?.secretArn ?? '',
    });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, 'DocumentsBucketName', {
      value: documentsBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.distributionDomainName,
    });
    // Set this as the GitHub Actions repo variable AWS_DEPLOY_ROLE_ARN (used by aws.yml OIDC).
    new cdk.CfnOutput(this, 'GithubDeployRoleArn', {
      value: githubDeployRole.roleArn,
    });
  }
}

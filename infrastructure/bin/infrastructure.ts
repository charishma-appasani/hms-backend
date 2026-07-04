#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { InfrastructureStack } from '../lib/infrastructure-stack';

const app = new cdk.App();

// Account/region come from the deploying pipeline's credentials (one account per env).
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'ap-south-2', // Hyderabad (India data residency)
};

// One stack for the whole HMS app (backend foundation + frontend hosting).
//
// Backend ALB HTTPS — ACM cert IN THIS REGION (ap-south-2):
//   -c certificateArn=arn:aws:acm:ap-south-2:...:certificate/...
// Frontend custom domain — a domain + a us-east-1 ACM cert (CloudFront only accepts us-east-1 certs;
// this is a DIFFERENT cert from the ALB one, even for the same domain):
//   -c frontendDomainName=dev.aayufy.com -c frontendCertificateArn=arn:aws:acm:us-east-1:...
const certificateArn = app.node.tryGetContext('certificateArn') as
  | string
  | undefined;
const frontendDomainName = app.node.tryGetContext('frontendDomainName') as
  | string
  | undefined;
const frontendCertificateArn = app.node.tryGetContext(
  'frontendCertificateArn',
) as string | undefined;

new InfrastructureStack(app, 'Hms', {
  certificateArn,
  frontendDomainName,
  frontendCertificateArn,
  env,
  description: 'HMS infrastructure (backend + frontend hosting)',
});

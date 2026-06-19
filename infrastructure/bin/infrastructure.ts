#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { InfrastructureStack } from '../lib/infrastructure-stack';

const app = new cdk.App();

// HTTPS is enabled when an ACM cert (in this region) is supplied:
//   cdk deploy -c certificateArn=arn:aws:acm:ap-south-2:...:certificate/...
const certificateArn = app.node.tryGetContext('certificateArn') as
  | string
  | undefined;

new InfrastructureStack(app, 'Hms-Backend', {
  certificateArn,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-south-2', // Hyderabad (India data residency)
  },
  description: 'HMS backend infrastructure',
});

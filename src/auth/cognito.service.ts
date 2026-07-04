import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
  type AttributeType,
} from '@aws-sdk/client-cognito-identity-provider';
import type { Env } from '../config/env.schema';

/** Demographics needed to provision a login identity for an invited staff member. */
export interface ProvisionUserInput {
  email: string;
  phone?: string;
  firstName: string;
  lastName?: string;
  /**
   * When set, the invite email is SUPPRESSED and this permanent password is set so the user can log
   * in immediately (used for first-instance bootstrap). Omit for the normal staff-invite flow.
   */
  password?: string;
}

/** Demographics for provisioning a patient identity (phone and/or email; at least one). */
export interface ProvisionPatientInput {
  phone?: string;
  email?: string;
  firstName: string;
  lastName?: string;
  /** When set, the patient can log in immediately (self-signup); omit for staff-created records. */
  password?: string;
}

/**
 * Wraps the Cognito Admin API for provisioning staff login identities (the single shared user
 * pool). The IAM actions this needs are granted to the Fargate task role in the CDK stack
 * (cognito-idp:AdminCreateUser / AdminGetUser, scoped to the pool).
 */
@Injectable()
export class CognitoService {
  private readonly client: CognitoIdentityProviderClient;
  private readonly userPoolId: string;

  constructor(config: ConfigService<Env, true>) {
    this.userPoolId = config.getOrThrow('COGNITO_USER_POOL_ID');
    this.client = new CognitoIdentityProviderClient({
      region: config.getOrThrow('AWS_REGION'),
    });
  }

  /**
   * Creates the Cognito user and returns its immutable `sub` — stored as `app_user.cognito_sub`. By
   * default emails the invite + temporary password (FORCE_CHANGE_PASSWORD). If `input.password` is
   * set, the invite is suppressed and a permanent password is set so the user can log in straight
   * away (bootstrap). If the Cognito user already exists (created earlier but never linked to an
   * app_user), reuses it via AdminGetUser instead of failing.
   */
  async provisionUser(input: ProvisionUserInput): Promise<string> {
    const attributes: AttributeType[] = [
      { Name: 'email', Value: input.email },
      { Name: 'email_verified', Value: 'true' }, // admin-invited → trusted
      { Name: 'given_name', Value: input.firstName },
    ];
    if (input.lastName) {
      attributes.push({ Name: 'family_name', Value: input.lastName });
    }
    if (input.phone) {
      attributes.push({ Name: 'phone_number', Value: input.phone });
      attributes.push({ Name: 'phone_number_verified', Value: 'false' });
    }

    let sub: string;
    try {
      const res = await this.client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: input.email,
          UserAttributes: attributes,
          // With a password we set it ourselves (below) and don't email an invite.
          ...(input.password
            ? { MessageAction: 'SUPPRESS' }
            : { DesiredDeliveryMediums: ['EMAIL'] }),
        }),
      );
      sub = this.extractSub(res.User?.Attributes);
    } catch (err) {
      if (err instanceof UsernameExistsException) {
        const res = await this.client.send(
          new AdminGetUserCommand({
            UserPoolId: this.userPoolId,
            Username: input.email,
          }),
        );
        sub = this.extractSub(res.UserAttributes);
      } else {
        throw err;
      }
    }

    if (input.password) {
      await this.client.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: this.userPoolId,
          Username: input.email,
          Password: input.password,
          Permanent: true,
        }),
      );
    }
    return sub;
  }

  /**
   * Provision a patient login (username = phone or email; invite suppressed — patients aren't
   * emailed a temp password). Each person has a unique phone/email, so this normally creates a
   * fresh user; if the username already exists in Cognito (drift from a deleted app_user), it links
   * the existing `sub` via AdminGetUser. With `password`, the user can log in immediately
   * (self-signup); without it, the record is dormant until the patient activates.
   */
  async provisionPatient(input: ProvisionPatientInput): Promise<string> {
    const username = input.phone ?? input.email;
    if (!username) {
      throw new Error('provisionPatient requires a phone or email');
    }
    const attributes: AttributeType[] = [
      { Name: 'given_name', Value: input.firstName },
    ];
    if (input.lastName) {
      attributes.push({ Name: 'family_name', Value: input.lastName });
    }
    if (input.phone) {
      attributes.push({ Name: 'phone_number', Value: input.phone });
      attributes.push({ Name: 'phone_number_verified', Value: 'true' });
    }
    if (input.email) {
      attributes.push({ Name: 'email', Value: input.email });
      // Verified only when email is the sole identifier (no phone to verify against).
      attributes.push({
        Name: 'email_verified',
        Value: input.phone ? 'false' : 'true',
      });
    }

    let sub: string;
    try {
      const res = await this.client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: username,
          UserAttributes: attributes,
          MessageAction: 'SUPPRESS',
        }),
      );
      sub = this.extractSub(res.User?.Attributes);
    } catch (err) {
      if (err instanceof UsernameExistsException) {
        const res = await this.client.send(
          new AdminGetUserCommand({
            UserPoolId: this.userPoolId,
            Username: username,
          }),
        );
        sub = this.extractSub(res.UserAttributes);
      } else {
        throw err;
      }
    }

    if (input.password) {
      await this.client.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: this.userPoolId,
          Username: username,
          Password: input.password,
          Permanent: true,
        }),
      );
    }
    return sub;
  }

  private extractSub(attributes: AttributeType[] | undefined): string {
    const sub = attributes?.find((a) => a.Name === 'sub')?.Value;
    if (!sub) {
      throw new Error('Cognito user has no sub attribute');
    }
    return sub;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import type {
  NotificationMessage,
  NotificationRecipient,
} from './notification.types';

/** Token for the array of channels the NotificationService dispatches to. */
export const NOTIFICATION_CHANNELS = Symbol('NOTIFICATION_CHANNELS');

/**
 * A delivery channel. Add a real channel by implementing this and registering it in
 * notification.module.ts — the service automatically fans out to every channel a recipient supports.
 */
export interface NotificationChannel {
  readonly channel: 'email' | 'sms';
  supports(recipient: NotificationRecipient): boolean;
  send(
    recipient: NotificationRecipient,
    message: NotificationMessage,
  ): Promise<void>;
}

/**
 * STUB email channel — logs instead of sending. Replace with a real SES channel once
 * `@aws-sdk/client-sesv2` is installed (the Fargate task role already has ses:SendEmail).
 */
@Injectable()
export class LoggingEmailChannel implements NotificationChannel {
  readonly channel = 'email' as const;
  private readonly logger = new Logger('EmailChannel');

  supports(recipient: NotificationRecipient): boolean {
    return Boolean(recipient.email);
  }

  async send(
    recipient: NotificationRecipient,
    message: NotificationMessage,
  ): Promise<void> {
    this.logger.log(`[stub] email → ${recipient.email}: ${message.subject}`);
  }
}

/**
 * STUB SMS channel — logs instead of sending. Replace with a real SNS channel once
 * `@aws-sdk/client-sns` is installed AND the India DLT sender-ID/templates are registered.
 */
@Injectable()
export class LoggingSmsChannel implements NotificationChannel {
  readonly channel = 'sms' as const;
  private readonly logger = new Logger('SmsChannel');

  supports(recipient: NotificationRecipient): boolean {
    return Boolean(recipient.phone);
  }

  async send(
    recipient: NotificationRecipient,
    message: NotificationMessage,
  ): Promise<void> {
    this.logger.log(`[stub] sms → ${recipient.phone}: ${message.subject}`);
  }
}

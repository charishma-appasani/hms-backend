import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  SNSClient,
  PublishCommand,
  type MessageAttributeValue,
} from '@aws-sdk/client-sns';
import type { Env } from '../config/env.schema';
import type { NotificationChannel } from './notification.channel';
import type {
  NotificationMessage,
  NotificationRecipient,
} from './notification.types';

/** Real email delivery via SES v2. Requires a verified `NOTIFICATIONS_EMAIL_FROM` sender. */
@Injectable()
export class SesEmailChannel implements NotificationChannel {
  readonly channel = 'email' as const;
  private readonly client: SESv2Client;
  private readonly from?: string;

  constructor(config: ConfigService<Env, true>) {
    this.from = config.get('NOTIFICATIONS_EMAIL_FROM', { infer: true });
    this.client = new SESv2Client({ region: config.getOrThrow('AWS_REGION') });
  }

  supports(recipient: NotificationRecipient): boolean {
    return Boolean(recipient.email && this.from);
  }

  async send(
    recipient: NotificationRecipient,
    message: NotificationMessage,
  ): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [recipient.email as string] },
        Content: {
          Simple: {
            Subject: { Data: message.subject },
            Body: { Text: { Data: message.body } },
          },
        },
      }),
    );
  }
}

/**
 * Real SMS delivery via SNS. India transactional SMS additionally needs DLT registration: set
 * SMS_SENDER_ID + SMS_DLT_ENTITY_ID, and (per message template) a DLT template id — the latter is
 * NOT wired here because each event would map to its own registered template; add per-event
 * AWS.MM.SMS.TemplateId when those template ids exist.
 */
@Injectable()
export class SnsSmsChannel implements NotificationChannel {
  readonly channel = 'sms' as const;
  private readonly client: SNSClient;
  private readonly senderId?: string;
  private readonly entityId?: string;
  private readonly logger = new Logger('SnsSmsChannel');

  constructor(config: ConfigService<Env, true>) {
    this.client = new SNSClient({ region: config.getOrThrow('AWS_REGION') });
    this.senderId = config.get('SMS_SENDER_ID', { infer: true });
    this.entityId = config.get('SMS_DLT_ENTITY_ID', { infer: true });
  }

  supports(recipient: NotificationRecipient): boolean {
    return Boolean(recipient.phone);
  }

  async send(
    recipient: NotificationRecipient,
    message: NotificationMessage,
  ): Promise<void> {
    const attributes: Record<string, MessageAttributeValue> = {
      'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
    };
    if (this.senderId) {
      attributes['AWS.SNS.SMS.SenderID'] = {
        DataType: 'String',
        StringValue: this.senderId,
      };
    }
    if (this.entityId) {
      attributes['AWS.MM.SMS.EntityId'] = {
        DataType: 'String',
        StringValue: this.entityId,
      };
    } else {
      this.logger.warn(
        'Sending SMS without a DLT entity id — Indian carriers will reject it.',
      );
    }
    await this.client.send(
      new PublishCommand({
        PhoneNumber: recipient.phone as string,
        Message: `${message.subject}\n\n${message.body}`,
        MessageAttributes: attributes,
      }),
    );
  }
}

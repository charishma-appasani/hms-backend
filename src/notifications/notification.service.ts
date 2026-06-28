import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
} from './notification.channel';
import type {
  NotificationEvent,
  NotificationMessage,
  NotificationRecipient,
} from './notification.types';

/**
 * Builds patient-facing messages for schedule-change events and fans them out to every delivery
 * channel the recipient supports (email + SMS today, both stubbed). Best-effort: a channel failure
 * is logged, never thrown — notifying must not roll back the schedule change that triggered it.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger('NotificationService');

  constructor(
    @Inject(NOTIFICATION_CHANNELS)
    private readonly channels: NotificationChannel[],
  ) {}

  /** Notify a recipient about an event; returns the channels it was delivered to. */
  async notify(
    recipient: NotificationRecipient,
    event: NotificationEvent,
  ): Promise<{ sentVia: string[] }> {
    return this.dispatch(recipient, buildMessage(recipient, event));
  }

  /** Send a ready-made message (e.g. an OTP) to every channel the recipient supports. */
  async dispatch(
    recipient: NotificationRecipient,
    message: NotificationMessage,
  ): Promise<{ sentVia: string[] }> {
    const sentVia: string[] = [];
    for (const channel of this.channels) {
      if (!channel.supports(recipient)) continue;
      try {
        await channel.send(recipient, message);
        sentVia.push(channel.channel);
      } catch (err) {
        this.logger.warn(
          `Failed to notify ${recipient.name} via ${channel.channel}: ${String(err)}`,
        );
      }
    }
    return { sentVia };
  }
}

function buildMessage(
  recipient: NotificationRecipient,
  event: NotificationEvent,
): NotificationMessage {
  const hi = `Dear ${recipient.name},`;
  const because = event.reason ? ` (${event.reason})` : '';
  switch (event.kind) {
    case 'appointment_rescheduled':
      return {
        subject: 'Your appointment has been rescheduled',
        body:
          `${hi} your appointment on ${event.from.sessionDate} ` +
          `(token ${event.from.tokenNumber ?? '-'}) has been moved to ` +
          `${event.to.sessionDate} (token ${event.to.tokenNumber ?? '-'})${because}. ` +
          `Please contact us if this does not suit you.`,
      };
    case 'appointment_cancelled':
      return {
        subject: 'Your appointment has been cancelled',
        body:
          `${hi} your appointment on ${event.appointment.sessionDate} ` +
          `(token ${event.appointment.tokenNumber ?? '-'}) has been cancelled${because}. ` +
          `Please rebook at your convenience.`,
      };
  }
}

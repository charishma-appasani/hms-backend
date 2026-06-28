import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LoggingEmailChannel,
  LoggingSmsChannel,
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
} from './notification.channel';
import { SesEmailChannel, SnsSmsChannel } from './aws-channels';
import { NotificationService } from './notification.service';
import type { Env } from '../config/env.schema';

/**
 * Global so any feature can inject NotificationService. When NOTIFICATIONS_ENABLED is true the
 * service dispatches via real SES (email) + SNS (SMS); otherwise via logging stubs (local/CI never
 * send). All channels are constructed either way (AWS clients are lazy) — the flag only selects
 * which set NOTIFICATION_CHANNELS exposes.
 */
@Global()
@Module({
  providers: [
    LoggingEmailChannel,
    LoggingSmsChannel,
    SesEmailChannel,
    SnsSmsChannel,
    {
      provide: NOTIFICATION_CHANNELS,
      useFactory: (
        config: ConfigService<Env, true>,
        ses: SesEmailChannel,
        sns: SnsSmsChannel,
        emailStub: LoggingEmailChannel,
        smsStub: LoggingSmsChannel,
      ): NotificationChannel[] =>
        config.get('NOTIFICATIONS_ENABLED', { infer: true })
          ? [ses, sns]
          : [emailStub, smsStub],
      inject: [
        ConfigService,
        SesEmailChannel,
        SnsSmsChannel,
        LoggingEmailChannel,
        LoggingSmsChannel,
      ],
    },
    NotificationService,
  ],
  exports: [NotificationService],
})
export class NotificationModule {}

import { Global, Module } from '@nestjs/common';
import { OtpService } from './otp.service';

/** Global so any feature can issue/verify phone OTPs (rate-limited at the DB) via OtpService. */
@Global()
@Module({
  providers: [OtpService],
  exports: [OtpService],
})
export class OtpModule {}

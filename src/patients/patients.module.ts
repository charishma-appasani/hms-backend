import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PatientsController } from './patients.controller';
import { PatientsService } from './patients.service';

/**
 * Patient identity + profile + org registration; staff-create and public OTP self-signup.
 * CognitoService from AuthModule; OtpService from the global OtpModule.
 */
@Module({
  imports: [AuthModule],
  controllers: [PatientsController],
  providers: [PatientsService],
})
export class PatientsModule {}

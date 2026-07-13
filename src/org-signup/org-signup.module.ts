import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrgSignupController } from './org-signup.controller';
import { OrgSignupService } from './org-signup.service';

/** Public org self-signup (AuthModule provides CognitoService; Otp/Audit/Notification are global). */
@Module({
  imports: [AuthModule],
  controllers: [OrgSignupController],
  providers: [OrgSignupService],
})
export class OrgSignupModule {}

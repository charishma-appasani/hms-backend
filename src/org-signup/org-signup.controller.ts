import { Body, Controller, Ip, Post } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { OrgSignupService } from './org-signup.service';
import {
  orgSignupStartSchema,
  orgSignupVerifySchema,
  type OrgSignupStartDto,
  type OrgSignupVerifyDto,
} from './dto/org-signup.dto';

/** Public org self-signup (OTP): request a code to the admin's email, then verify + create. */
@Controller('org-signup')
export class OrgSignupController {
  constructor(private readonly orgSignup: OrgSignupService) {}

  @Public()
  @Post('start')
  start(
    @Body(new ZodValidationPipe(orgSignupStartSchema)) dto: OrgSignupStartDto,
    @Ip() ip: string,
  ) {
    return this.orgSignup.start(dto, ip);
  }

  @Public()
  @Post('verify')
  verify(
    @Body(new ZodValidationPipe(orgSignupVerifySchema)) dto: OrgSignupVerifyDto,
  ) {
    return this.orgSignup.verify(dto);
  }
}

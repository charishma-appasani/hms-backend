import { Body, Controller, Post } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PatientPortalService } from './patient-portal.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  activatePatientProfileSchema,
  type ActivatePatientProfileDto,
} from './dto/activate-profile.dto';

/**
 * Patient-profile activation for an existing account (the account-menu "Sign up as a patient"
 * action). Deliberately a SEPARATE controller from PatientPortalController: that one is gated by
 * PatientContextGuard, which requires the patient profile to already exist — so it cannot gate the
 * route that creates it. Only the global JwtAuthGuard applies here.
 */
@Controller('me')
export class PatientProfileController {
  constructor(private readonly portal: PatientPortalService) {}

  @Post('patient-profile')
  activate(
    @CurrentUser() auth: AuthenticatedUser,
    @Body(new ZodValidationPipe(activatePatientProfileSchema))
    dto: ActivatePatientProfileDto,
  ) {
    return this.portal.activatePatientProfile(auth.user, dto);
  }
}

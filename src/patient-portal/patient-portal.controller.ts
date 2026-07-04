import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PatientContextGuard } from './patient-context.guard';
import { CurrentPatient } from './current-patient.decorator';
import type { PatientContext } from './patient-context.guard';
import { PatientPortalService } from './patient-portal.service';
import { PatientBookingService } from './patient-booking.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  selfBookSchema,
  selfRescheduleSchema,
  type SelfBookDto,
  type SelfRescheduleDto,
} from './dto/directory.dto';
import { updateProfileSchema, type UpdateProfileDto } from './dto/profile.dto';

/**
 * Patient portal — the caller's OWN record across all their orgs. Gated by PatientContextGuard
 * (requires a patient profile). Part A is read-only; self-booking lands in Part B.
 */
@Controller('me')
@UseGuards(PatientContextGuard)
export class PatientPortalController {
  constructor(
    private readonly portal: PatientPortalService,
    private readonly booking: PatientBookingService,
  ) {}

  @Get('profile')
  profile(@CurrentPatient() patient: PatientContext) {
    return this.portal.profile(patient.userId);
  }

  @Patch('profile')
  updateProfile(
    @CurrentPatient() patient: PatientContext,
    @Body(new ZodValidationPipe(updateProfileSchema)) dto: UpdateProfileDto,
  ) {
    return this.portal.updateProfile(patient.userId, dto);
  }

  @Get('registrations')
  registrations(@CurrentPatient() patient: PatientContext) {
    return this.portal.registrations(patient.patientId);
  }

  @Get('appointments')
  appointments(@CurrentPatient() patient: PatientContext) {
    return this.portal.appointments(patient.patientId);
  }

  /** Self-book into a slot (auto-registers at the org on first booking). */
  @Post('appointments')
  book(
    @CurrentPatient() patient: PatientContext,
    @Body(new ZodValidationPipe(selfBookSchema)) dto: SelfBookDto,
  ) {
    return this.booking.book(patient.patientId, dto);
  }

  @Patch('appointments/:id/cancel')
  cancel(
    @CurrentPatient() patient: PatientContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.booking.cancel(patient.patientId, id);
  }

  @Patch('appointments/:id/reschedule')
  reschedule(
    @CurrentPatient() patient: PatientContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(selfRescheduleSchema)) dto: SelfRescheduleDto,
  ) {
    return this.booking.reschedule(patient.patientId, id, dto.slotId);
  }

  @Get('visits')
  visits(@CurrentPatient() patient: PatientContext) {
    return this.portal.visits(patient.patientId);
  }

  @Get('visits/:id')
  visit(
    @CurrentPatient() patient: PatientContext,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.portal.visit(patient.patientId, id);
  }
}

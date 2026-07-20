import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { Public } from '../auth/public.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PatientsService } from './patients.service';
import {
  createPatientSchema,
  updatePatientSchema,
  signupStartSchema,
  signupVerifySchema,
  linkStartSchema,
  linkVerifySchema,
  createConditionSchema,
  updateConditionSchema,
  type CreatePatientDto,
  type UpdatePatientDto,
  type SignupStartDto,
  type SignupVerifyDto,
  type LinkStartDto,
  type LinkVerifyDto,
  type CreateConditionDto,
  type UpdateConditionDto,
} from './dto/patient.dto';

/** Any active member may read the org's patients; front desk / nurses register + edit them. */
const ORG_MEMBER = [
  'admin',
  'doctor',
  'doctor_assistant',
  'front_desk',
  'nurse',
] as const;
const FRONT_DESK = ['admin', 'front_desk', 'nurse'] as const;
// Who records conditions/allergies. doctor_assistant records on the doctor's behalf.
const CLINICAL = ['admin', 'doctor', 'doctor_assistant', 'nurse'] as const;

@Controller('patients')
export class PatientsController {
  constructor(private readonly patients: PatientsService) {}

  // ── self-signup (public, OTP) ──
  @Public()
  @Post('signup/start')
  signupStart(
    @Body(new ZodValidationPipe(signupStartSchema)) dto: SignupStartDto,
    @Ip() ip: string,
  ) {
    return this.patients.signupStart(dto, ip);
  }

  @Public()
  @Post('signup/verify')
  signupVerify(
    @Body(new ZodValidationPipe(signupVerifySchema)) dto: SignupVerifyDto,
  ) {
    return this.patients.signupVerify(dto);
  }

  // ── cross-org link (org-scoped, OTP consent) ──
  @Post('link/start')
  @Roles(...FRONT_DESK)
  linkStart(
    @Body(new ZodValidationPipe(linkStartSchema)) dto: LinkStartDto,
    @Ip() ip: string,
  ) {
    return this.patients.linkStart(dto, ip);
  }

  @Post('link/verify')
  @Roles(...FRONT_DESK)
  linkVerify(
    @Body(new ZodValidationPipe(linkVerifySchema)) dto: LinkVerifyDto,
  ) {
    return this.patients.linkVerify(dto);
  }

  // ── staff-managed (org-scoped) ──
  @Post()
  @Roles(...FRONT_DESK)
  create(
    @Body(new ZodValidationPipe(createPatientSchema)) dto: CreatePatientDto,
  ) {
    return this.patients.createByStaff(dto);
  }

  @Get()
  @Roles(...ORG_MEMBER)
  list() {
    return this.patients.list();
  }

  @Get(':id')
  @Roles(...ORG_MEMBER)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.patients.get(id);
  }

  @Patch(':id')
  @Roles(...FRONT_DESK)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updatePatientSchema)) dto: UpdatePatientDto,
  ) {
    return this.patients.update(id, dto);
  }

  // ── conditions & allergies (patient-global; requires an active registration here) ──

  @Get(':id/conditions')
  @Roles(...ORG_MEMBER)
  listConditions(@Param('id', ParseUUIDPipe) id: string) {
    return this.patients.listConditions(id);
  }

  @Post(':id/conditions')
  @Roles(...CLINICAL)
  addCondition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createConditionSchema)) dto: CreateConditionDto,
  ) {
    return this.patients.addCondition(id, dto);
  }

  @Patch(':id/conditions/:conditionId')
  @Roles(...CLINICAL)
  updateCondition(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('conditionId', ParseUUIDPipe) conditionId: string,
    @Body(new ZodValidationPipe(updateConditionSchema)) dto: UpdateConditionDto,
  ) {
    return this.patients.updateCondition(id, conditionId, dto);
  }

  @Delete(':id/conditions/:conditionId')
  @Roles(...CLINICAL)
  @HttpCode(204)
  removeCondition(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('conditionId', ParseUUIDPipe) conditionId: string,
  ): Promise<void> {
    return this.patients.removeCondition(id, conditionId);
  }
}

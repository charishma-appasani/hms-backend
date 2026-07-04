import {
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import type { PatientContext, PatientRequest } from './patient-context.guard';

/** Injects the resolved {@link PatientContext} (pair with `@UseGuards(PatientContextGuard)`). */
export const CurrentPatient = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PatientContext => {
    const request = ctx.switchToHttp().getRequest<PatientRequest>();
    if (!request.patientContext) {
      throw new ForbiddenException('Patient context required');
    }
    return request.patientContext;
  },
);

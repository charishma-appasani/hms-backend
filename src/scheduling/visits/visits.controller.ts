import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../../auth/roles.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { VisitsService } from './visits.service';
import {
  checkInSchema,
  updateVisitStatusSchema,
  visitVitalsSchema,
  queueQuerySchema,
  updateClinicalSchema,
  createPrescriptionSchema,
  createTestOrderSchema,
  updateTestOrderSchema,
  type CheckInDto,
  type UpdateVisitStatusDto,
  type VisitVitalsDto,
  type QueueQueryDto,
  type UpdateClinicalDto,
  type CreatePrescriptionDto,
  type CreateTestOrderDto,
  type UpdateTestOrderDto,
} from './dto/visit.dto';

const ORG_MEMBER = ['admin', 'doctor', 'front_desk', 'nurse'] as const;
// Who can check patients in / start the visit. Includes doctor (a doctor can start their own visit).
const FRONT_DESK = ['admin', 'doctor', 'front_desk', 'nurse'] as const;
const CLINICAL = ['admin', 'doctor', 'nurse'] as const; // who records the clinical note

@Controller('visits')
export class VisitsController {
  constructor(private readonly visits: VisitsService) {}

  @Post('check-in')
  @Roles(...FRONT_DESK)
  checkIn(@Body(new ZodValidationPipe(checkInSchema)) dto: CheckInDto) {
    return this.visits.checkIn(dto.appointmentId);
  }

  @Get('queue')
  @Roles(...ORG_MEMBER)
  queue(@Query(new ZodValidationPipe(queueQuerySchema)) query: QueueQueryDto) {
    return this.visits.queue(query);
  }

  @Get(':id')
  @Roles(...ORG_MEMBER)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.visits.get(id);
  }

  @Patch(':id/status')
  @Roles(...ORG_MEMBER)
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateVisitStatusSchema))
    dto: UpdateVisitStatusDto,
  ) {
    return this.visits.updateStatus(id, dto);
  }

  @Patch(':id/vitals')
  @Roles(...CLINICAL)
  setVitals(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(visitVitalsSchema)) dto: VisitVitalsDto,
  ) {
    return this.visits.setVitals(id, dto);
  }

  // ── clinical record (doctor-entered) ──

  @Patch(':id/clinical')
  @Roles(...CLINICAL)
  setClinical(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateClinicalSchema)) dto: UpdateClinicalDto,
  ) {
    return this.visits.setClinical(id, dto);
  }

  @Post(':id/prescriptions')
  @Roles(...CLINICAL)
  addPrescription(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createPrescriptionSchema))
    dto: CreatePrescriptionDto,
  ) {
    return this.visits.addPrescription(id, dto);
  }

  @Delete(':id/prescriptions/:prescriptionId')
  @Roles(...CLINICAL)
  @HttpCode(204)
  removePrescription(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('prescriptionId', ParseUUIDPipe) prescriptionId: string,
  ): Promise<void> {
    return this.visits.removePrescription(id, prescriptionId);
  }

  @Post(':id/tests')
  @Roles(...CLINICAL)
  addTestOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createTestOrderSchema)) dto: CreateTestOrderDto,
  ) {
    return this.visits.addTestOrder(id, dto);
  }

  @Patch(':id/tests/:testOrderId')
  @Roles(...CLINICAL)
  updateTestOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('testOrderId', ParseUUIDPipe) testOrderId: string,
    @Body(new ZodValidationPipe(updateTestOrderSchema)) dto: UpdateTestOrderDto,
  ) {
    return this.visits.updateTestOrder(id, testOrderId, dto);
  }

  @Delete(':id/tests/:testOrderId')
  @Roles(...CLINICAL)
  @HttpCode(204)
  removeTestOrder(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('testOrderId', ParseUUIDPipe) testOrderId: string,
  ): Promise<void> {
    return this.visits.removeTestOrder(id, testOrderId);
  }
}

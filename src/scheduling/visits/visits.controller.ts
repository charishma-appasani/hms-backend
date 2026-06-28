import {
  Body,
  Controller,
  Get,
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
  type CheckInDto,
  type UpdateVisitStatusDto,
  type VisitVitalsDto,
  type QueueQueryDto,
} from './dto/visit.dto';

const ORG_MEMBER = ['admin', 'doctor', 'front_desk', 'nurse'] as const;
const FRONT_DESK = ['admin', 'front_desk', 'nurse'] as const; // who checks patients in
const CLINICAL = ['admin', 'doctor', 'nurse'] as const; // who records vitals

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
  queue(
    @Query(new ZodValidationPipe(queueQuerySchema)) query: QueueQueryDto,
  ) {
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
}

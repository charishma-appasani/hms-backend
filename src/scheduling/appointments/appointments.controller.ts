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
import { AppointmentsService } from './appointments.service';
import {
  bookAppointmentSchema,
  walkInSchema,
  rescheduleSchema,
  listAppointmentsQuerySchema,
  type BookAppointmentDto,
  type WalkInDto,
  type RescheduleDto,
  type ListAppointmentsQueryDto,
} from './dto/book-appointment.dto';

/** Front desk + admins book/cancel; any member may read the schedule / queue. */
const ORG_MEMBER = ['admin', 'doctor', 'front_desk', 'nurse'] as const;
const FRONT_DESK = ['admin', 'front_desk'] as const;

@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Post()
  @Roles(...FRONT_DESK)
  book(
    @Body(new ZodValidationPipe(bookAppointmentSchema)) dto: BookAppointmentDto,
  ) {
    return this.appointments.book(dto);
  }

  @Post('walk-in')
  @Roles(...FRONT_DESK)
  walkIn(@Body(new ZodValidationPipe(walkInSchema)) dto: WalkInDto) {
    return this.appointments.walkIn(dto);
  }

  @Get()
  @Roles(...ORG_MEMBER)
  list(
    @Query(new ZodValidationPipe(listAppointmentsQuerySchema))
    query: ListAppointmentsQueryDto,
  ) {
    return this.appointments.list(query);
  }

  @Get(':id')
  @Roles(...ORG_MEMBER)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.appointments.get(id);
  }

  @Patch(':id/reschedule')
  @Roles(...FRONT_DESK)
  reschedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(rescheduleSchema)) dto: RescheduleDto,
  ) {
    return this.appointments.reschedule(id, dto.slotId);
  }

  @Patch(':id/cancel')
  @Roles(...FRONT_DESK)
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.appointments.cancel(id);
  }
}

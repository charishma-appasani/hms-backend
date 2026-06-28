import { Module } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module';
import { ScheduleExceptionsController } from './schedule-exceptions.controller';
import { ScheduleExceptionsService } from './schedule-exceptions.service';

/**
 * Doctor blocks that block overlapping slots and auto-relocate displaced bookings. Imports
 * AppointmentsModule to reuse reschedule/cancel for relocation.
 */
@Module({
  imports: [AppointmentsModule],
  controllers: [ScheduleExceptionsController],
  providers: [ScheduleExceptionsService],
})
export class ScheduleExceptionsModule {}

import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { RelocationService } from './relocation.service';

/**
 * Appointment booking, walk-ins, cancellation, reschedule, plus RelocationService — the shared
 * displaced-booking mover used by schedule blocks and template drop/replace.
 */
@Module({
  controllers: [AppointmentsController],
  providers: [AppointmentsService, RelocationService],
  exports: [AppointmentsService, RelocationService],
})
export class AppointmentsModule {}

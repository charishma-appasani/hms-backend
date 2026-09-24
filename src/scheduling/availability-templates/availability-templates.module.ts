import { Module } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module';
import { AvailabilityTemplatesController } from './availability-templates.controller';
import { AvailabilityTemplatesService } from './availability-templates.service';

/** Recurring availability templates — input to slot generation; drop/replace migrate bookings. */
@Module({
  imports: [AppointmentsModule],
  controllers: [AvailabilityTemplatesController],
  providers: [AvailabilityTemplatesService],
  exports: [AvailabilityTemplatesService], // staff removal retires the provider's schedule
})
export class AvailabilityTemplatesModule {}

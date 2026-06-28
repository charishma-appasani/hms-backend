import { Module } from '@nestjs/common';
import { SlotsController } from './slots.controller';
import { SlotsService } from './slots.service';

/**
 * Slot availability + lazy generation. Exports SlotsService so the booking module can ensure a
 * slot exists (and operate on its atomic counters) before confirming an appointment.
 */
@Module({
  controllers: [SlotsController],
  providers: [SlotsService],
  exports: [SlotsService],
})
export class SlotsModule {}

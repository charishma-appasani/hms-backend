import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../auth/roles.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SlotsService } from './slots.service';
import {
  availabilityQuerySchema,
  type AvailabilityQueryDto,
} from './dto/availability-query.dto';

/** Any active member may view availability (front desk books from it). */
const ORG_MEMBER = ['admin', 'doctor', 'front_desk', 'nurse'] as const;

@Controller('availability')
export class SlotsController {
  constructor(private readonly slots: SlotsService) {}

  /**
   * GET /availability?practiceId=&providerId=&date=YYYY-MM-DD — slots with computed availability
   * for the date. Slots are materialized on first view (see SlotsService).
   */
  @Get()
  @Roles(...ORG_MEMBER)
  getAvailability(
    @Query(new ZodValidationPipe(availabilityQuerySchema))
    query: AvailabilityQueryDto,
  ) {
    return this.slots.getAvailability(query);
  }
}

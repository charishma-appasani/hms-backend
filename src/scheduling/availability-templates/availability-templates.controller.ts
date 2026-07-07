import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../../auth/roles.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AvailabilityTemplatesService } from './availability-templates.service';
import {
  createAvailabilityTemplateSchema,
  type CreateAvailabilityTemplateDto,
} from './dto/availability-template.dto';

/** Any active member may read the schedule; only admins create/remove availability. */
const ORG_MEMBER = ['admin', 'doctor', 'front_desk', 'nurse'] as const;

@Controller('availability-templates')
export class AvailabilityTemplatesController {
  constructor(private readonly templates: AvailabilityTemplatesService) {}

  // Create the provider's weekly schedule (whole week in one call, startDate tomorrow+). There is
  // no edit: this SUPERSEDES their existing schedule at the practice from startDate on — old one
  // ends the day before; compatible bookings kept, the rest relocated (+notify).
  @Post()
  @Roles('admin')
  create(
    @Body(new ZodValidationPipe(createAvailabilityTemplateSchema))
    dto: CreateAvailabilityTemplateDto,
  ) {
    return this.templates.create(dto);
  }

  @Get()
  @Roles(...ORG_MEMBER)
  list(
    @Query('providerId') providerId?: string,
    @Query('practiceId') practiceId?: string,
  ) {
    return this.templates.list({ providerId, practiceId });
  }

  @Get(':id')
  @Roles(...ORG_MEMBER)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.get(id);
  }

  // Drop a schedule day: cancels its future bookings (+notify) and removes/blocks its slots.
  @Delete(':id')
  @Roles('admin')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.remove(id);
  }
}

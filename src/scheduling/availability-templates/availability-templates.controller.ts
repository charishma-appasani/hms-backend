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

  // Changing a live schedule = replace (migrates the old bookings to the new schedule).
  @Post(':id/replace')
  @Roles('admin')
  replace(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createAvailabilityTemplateSchema))
    dto: CreateAvailabilityTemplateDto,
  ) {
    return this.templates.replace(id, dto);
  }

  // Drop a schedule: cancels its future bookings (+notify) and removes/blocks its slots.
  @Delete(':id')
  @Roles('admin')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.templates.remove(id);
  }
}

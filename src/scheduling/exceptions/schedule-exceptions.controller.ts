import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentOrg } from '../../auth/current-org.decorator';
import { Roles } from '../../auth/roles.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import type { OrgContext } from '../../auth/auth.types';
import { ScheduleExceptionsService } from './schedule-exceptions.service';
import {
  createScheduleExceptionSchema,
  listScheduleExceptionsQuerySchema,
  type CreateScheduleExceptionDto,
  type ListScheduleExceptionsQueryDto,
} from './dto/schedule-exception.dto';

/** Any active member may view blocks; admins (any provider) and doctors (own) create/remove them. */
const ORG_MEMBER = [
  'admin',
  'doctor',
  'doctor_assistant',
  'front_desk',
  'nurse',
] as const;

@Controller('schedule-exceptions')
export class ScheduleExceptionsController {
  constructor(private readonly exceptions: ScheduleExceptionsService) {}

  @Post()
  @Roles('admin', 'doctor')
  create(
    @Body(new ZodValidationPipe(createScheduleExceptionSchema))
    dto: CreateScheduleExceptionDto,
    @CurrentOrg() org: OrgContext,
  ) {
    return this.exceptions.create(dto, org);
  }

  @Get()
  @Roles(...ORG_MEMBER)
  list(
    @Query(new ZodValidationPipe(listScheduleExceptionsQuerySchema))
    query: ListScheduleExceptionsQueryDto,
  ) {
    return this.exceptions.list(query);
  }

  @Get(':id')
  @Roles(...ORG_MEMBER)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.exceptions.get(id);
  }

  @Delete(':id')
  @Roles('admin', 'doctor')
  @HttpCode(204)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentOrg() org: OrgContext,
  ): Promise<void> {
    return this.exceptions.remove(id, org);
  }
}

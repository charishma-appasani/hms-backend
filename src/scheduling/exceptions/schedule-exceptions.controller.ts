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
import { Roles } from '../../auth/roles.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ScheduleExceptionsService } from './schedule-exceptions.service';
import {
  createScheduleExceptionSchema,
  listScheduleExceptionsQuerySchema,
  type CreateScheduleExceptionDto,
  type ListScheduleExceptionsQueryDto,
} from './dto/schedule-exception.dto';

/** Any active member may view blocks; only admins create/remove them. */
const ORG_MEMBER = ['admin', 'doctor', 'front_desk', 'nurse'] as const;

@Controller('schedule-exceptions')
export class ScheduleExceptionsController {
  constructor(private readonly exceptions: ScheduleExceptionsService) {}

  @Post()
  @Roles('admin')
  create(
    @Body(new ZodValidationPipe(createScheduleExceptionSchema))
    dto: CreateScheduleExceptionDto,
  ) {
    return this.exceptions.create(dto);
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
  @Roles('admin')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.exceptions.remove(id);
  }
}

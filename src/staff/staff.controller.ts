import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { StaffManageGuard } from './staff-manage.guard';
import { StaffService } from './staff.service';
import {
  createStaffSchema,
  updateStaffSchema,
  type CreateStaffDto,
  type UpdateStaffDto,
} from './dto/staff.dto';

/** Any active member may read the org's staff directory. */
const ORG_MEMBER = ['admin', 'doctor', 'front_desk', 'nurse'] as const;

/**
 * Staff (org membership) management. Mutations use StaffManageGuard (org admin OR platform
 * super_admin assuming the org for first-admin onboarding); reads are open to any member. All
 * routes require an `X-Org-Id`.
 */
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Post()
  @UseGuards(StaffManageGuard)
  create(@Body(new ZodValidationPipe(createStaffSchema)) dto: CreateStaffDto) {
    return this.staff.create(dto);
  }

  @Get()
  @Roles(...ORG_MEMBER)
  list() {
    return this.staff.list();
  }

  @Get(':id')
  @Roles(...ORG_MEMBER)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.get(id);
  }

  @Patch(':id')
  @UseGuards(StaffManageGuard)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateStaffSchema)) dto: UpdateStaffDto,
  ) {
    return this.staff.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(StaffManageGuard)
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.staff.remove(id);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { StaffManageGuard } from './staff-manage.guard';
import { StaffService } from './staff.service';
import { lookupSchema, type LookupDto } from '../common/contact.schema';
import {
  createStaffSchema,
  updateStaffSchema,
  type CreateStaffDto,
  type UpdateStaffDto,
} from './dto/staff.dto';

/** Any active member may read the org's staff directory. */
const ORG_MEMBER = [
  'admin',
  'doctor',
  'doctor_assistant',
  'front_desk',
  'nurse',
] as const;

/**
 * Staff (org membership) management. Mutations use StaffManageGuard (org admin OR platform
 * super_admin assuming the org for first-admin onboarding); reads are open to any member. All
 * routes require an `X-Org-Id`.
 */
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  /** Step 1 of adding staff: existing account → OTP sent to them (masked hint returned). */
  @Post('lookup')
  @UseGuards(StaffManageGuard)
  @HttpCode(200)
  lookup(
    @Body(new ZodValidationPipe(lookupSchema)) dto: LookupDto,
    @Ip() ip: string,
  ) {
    return this.staff.lookup(dto, ip);
  }

  /** Step 2: link the existing account (with `code`) or create a new person. */
  @Post()
  @UseGuards(StaffManageGuard)
  create(@Body(new ZodValidationPipe(createStaffSchema)) dto: CreateStaffDto) {
    return this.staff.create(dto);
  }

  /** `?includeRemoved=true` also returns soft-deleted memberships (admin screen, for re-activation). */
  @Get()
  @Roles(...ORG_MEMBER)
  list(@Query('includeRemoved') includeRemoved?: string) {
    return this.staff.list(includeRemoved === 'true');
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

  @Post(':id/disable')
  @UseGuards(StaffManageGuard)
  @HttpCode(200)
  disable(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.disable(id);
  }

  /** Re-activates a disabled or removed (soft-deleted) membership. */
  @Post(':id/activate')
  @UseGuards(StaffManageGuard)
  @HttpCode(200)
  activate(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.activate(id);
  }

  /** Emails a fresh temporary password to a member who has never signed in. */
  @Post(':id/resend-invite')
  @UseGuards(StaffManageGuard)
  @HttpCode(200)
  resendInvite(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.resendInvite(id);
  }

  /** Upcoming bookings a removal would cancel (for the confirmation dialog). */
  @Get(':id/removal-impact')
  @UseGuards(StaffManageGuard)
  removalImpact(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.removalImpact(id);
  }

  /** Removes the member AND cancels their upcoming appointments (patients are notified). */
  @Delete(':id')
  @UseGuards(StaffManageGuard)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.staff.remove(id);
  }
}

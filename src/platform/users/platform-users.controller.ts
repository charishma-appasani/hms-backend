import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { PlatformRoles } from '../../auth/platform-roles.decorator';
import { CurrentUser } from '../../auth/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { lookupSchema, type LookupDto } from '../../common/contact.schema';
import { PlatformUsersService } from './platform-users.service';
import {
  createPlatformUserSchema,
  type CreatePlatformUserDto,
} from './dto/platform-user.dto';

/**
 * Platform-operator management (our own super_admin/support users). Reads are open to support;
 * mutations are super_admin only. Carries no org context — operators live ABOVE tenants.
 */
@Controller('platform/users')
export class PlatformUsersController {
  constructor(private readonly users: PlatformUsersService) {}

  @Get()
  @PlatformRoles('super_admin', 'support')
  list() {
    return this.users.list();
  }

  /** Step 1 of adding an operator: existing account → OTP sent to them (masked hint returned). */
  @Post('lookup')
  @PlatformRoles('super_admin')
  @HttpCode(200)
  lookup(
    @Body(new ZodValidationPipe(lookupSchema)) dto: LookupDto,
    @Ip() ip: string,
  ) {
    return this.users.lookup(dto, ip);
  }

  /** Step 2: grant the role to the existing account (with `code`) or invite a new person. */
  @Post()
  @PlatformRoles('super_admin')
  create(
    @Body(new ZodValidationPipe(createPlatformUserSchema))
    dto: CreatePlatformUserDto,
    @CurrentUser() auth: AuthenticatedUser,
  ) {
    return this.users.create(dto, auth.user.id);
  }

  @Delete(':id')
  @PlatformRoles('super_admin')
  @HttpCode(204)
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() auth: AuthenticatedUser,
  ): Promise<void> {
    return this.users.revoke(id, auth.user.id);
  }
}

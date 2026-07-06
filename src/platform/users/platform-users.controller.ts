import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { PlatformRoles } from '../../auth/platform-roles.decorator';
import { CurrentUser } from '../../auth/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
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

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
} from '@nestjs/common';
import { PlatformRoles } from '../../auth/platform-roles.decorator';
import { CurrentUser } from '../../auth/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { OrganizationsService } from './organizations.service';
import {
  createOrganizationSchema,
  updateOrganizationSchema,
  type CreateOrganizationDto,
  type UpdateOrganizationDto,
} from './dto/organization.dto';

/**
 * Platform-operator namespace for managing tenant organizations. Reads are open to support;
 * mutations are super_admin only. Carries no org context — these routes operate ABOVE tenants.
 */
@Controller('platform/organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Post()
  @PlatformRoles('super_admin')
  create(
    @Body(new ZodValidationPipe(createOrganizationSchema))
    dto: CreateOrganizationDto,
    @CurrentUser() auth: AuthenticatedUser,
  ) {
    return this.organizations.create(dto, auth.user.id);
  }

  @Get()
  @PlatformRoles('super_admin', 'support')
  list() {
    return this.organizations.list();
  }

  @Get(':id')
  @PlatformRoles('super_admin', 'support')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.organizations.get(id);
  }

  @Patch(':id')
  @PlatformRoles('super_admin')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateOrganizationSchema))
    dto: UpdateOrganizationDto,
    @CurrentUser() auth: AuthenticatedUser,
  ) {
    return this.organizations.update(id, dto, auth.user.id);
  }

  @Delete(':id')
  @PlatformRoles('super_admin')
  @HttpCode(204)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() auth: AuthenticatedUser,
  ): Promise<void> {
    return this.organizations.remove(id, auth.user.id);
  }
}

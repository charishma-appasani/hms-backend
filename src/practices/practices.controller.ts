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
import { Roles } from '../auth/roles.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PracticesService } from './practices.service';
import {
  createPracticeSchema,
  updatePracticeSchema,
  type CreatePracticeDto,
  type UpdatePracticeDto,
} from './dto/practice.dto';

/** Any active member of the org may read its practices; only admins mutate them. */
const ORG_MEMBER = ['admin', 'doctor', 'front_desk', 'nurse'] as const;

/**
 * Practices live inside an org. All routes require an `X-Org-Id` with an active membership
 * (enforced by @Roles → OrgContextGuard/RolesGuard); the scoped client confines every query to
 * that org. There is no cross-org practice listing.
 */
@Controller('practices')
export class PracticesController {
  constructor(private readonly practices: PracticesService) {}

  @Post()
  @Roles('admin')
  create(
    @Body(new ZodValidationPipe(createPracticeSchema)) dto: CreatePracticeDto,
  ) {
    return this.practices.create(dto);
  }

  @Get()
  @Roles(...ORG_MEMBER)
  list() {
    return this.practices.list();
  }

  @Get(':id')
  @Roles(...ORG_MEMBER)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.practices.get(id);
  }

  @Patch(':id')
  @Roles('admin')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updatePracticeSchema)) dto: UpdatePracticeDto,
  ) {
    return this.practices.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.practices.remove(id);
  }
}

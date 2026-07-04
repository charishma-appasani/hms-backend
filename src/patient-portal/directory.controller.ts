import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PatientContextGuard } from './patient-context.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DirectoryService } from './directory.service';
import {
  directoryAvailabilityQuerySchema,
  type DirectoryAvailabilityQueryDto,
} from './dto/directory.dto';

/**
 * Provider directory for patients (`/directory/*`). Gated by PatientContextGuard — a signed-in
 * patient may browse any active org/practice/doctor and their availability (cross-org).
 */
@Controller('directory')
@UseGuards(PatientContextGuard)
export class DirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  @Get('orgs')
  orgs(@Query('q') q?: string) {
    return this.directory.orgs(q?.trim() || undefined);
  }

  @Get('orgs/:id')
  org(@Param('id', ParseUUIDPipe) id: string) {
    return this.directory.org(id);
  }

  @Get('availability')
  availability(
    @Query(new ZodValidationPipe(directoryAvailabilityQuerySchema))
    query: DirectoryAvailabilityQueryDto,
  ) {
    return this.directory.availability(query);
  }
}

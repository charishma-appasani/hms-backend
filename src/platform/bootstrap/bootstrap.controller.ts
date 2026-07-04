import { Body, Controller, Post } from '@nestjs/common';
import { Public } from '../../auth/public.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { BootstrapService } from './bootstrap.service';
import { bootstrapSchema, type BootstrapDto } from './dto/bootstrap.dto';

/**
 * Public, one-time instance bootstrap. `POST /platform/bootstrap` creates the first super_admin —
 * but only while the database is empty of users (see BootstrapService). Once any user exists it
 * returns 409, so it is inert on a live instance.
 */
@Controller('platform/bootstrap')
export class BootstrapController {
  constructor(private readonly bootstrap: BootstrapService) {}

  @Public()
  @Post()
  create(@Body(new ZodValidationPipe(bootstrapSchema)) dto: BootstrapDto) {
    return this.bootstrap.bootstrap(dto);
  }
}

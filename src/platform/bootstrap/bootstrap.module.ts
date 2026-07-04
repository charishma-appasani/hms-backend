import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { BootstrapController } from './bootstrap.controller';
import { BootstrapService } from './bootstrap.service';

/** First-instance super_admin bootstrap. Imports AuthModule for CognitoService. */
@Module({
  imports: [AuthModule],
  controllers: [BootstrapController],
  providers: [BootstrapService],
})
export class BootstrapModule {}

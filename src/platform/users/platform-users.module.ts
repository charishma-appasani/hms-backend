import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { PlatformUsersController } from './platform-users.controller';
import { PlatformUsersService } from './platform-users.service';

/** Platform-operator management (unscoped). Imports AuthModule for CognitoService. */
@Module({
  imports: [AuthModule],
  controllers: [PlatformUsersController],
  providers: [PlatformUsersService],
})
export class PlatformUsersModule {}

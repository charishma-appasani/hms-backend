import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

/**
 * Staff (org membership) management. Imports AuthModule for CognitoService; PrismaModule (global)
 * provides the scoped + unscoped Prisma accessors.
 */
@Module({
  imports: [AuthModule],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}

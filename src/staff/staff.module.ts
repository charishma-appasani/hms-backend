import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AvailabilityTemplatesModule } from '../scheduling/availability-templates/availability-templates.module';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';

/**
 * Staff (org membership) management. Imports AuthModule for CognitoService and
 * AvailabilityTemplatesModule to retire a removed doctor's schedule; PrismaModule (global)
 * provides the scoped + unscoped Prisma accessors.
 */
@Module({
  imports: [AuthModule, AvailabilityTemplatesModule],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}

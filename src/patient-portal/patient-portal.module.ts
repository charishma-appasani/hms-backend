import { Module } from '@nestjs/common';
import { PatientPortalController } from './patient-portal.controller';
import { PatientProfileController } from './patient-profile.controller';
import { DirectoryController } from './directory.controller';
import { PatientPortalService } from './patient-portal.service';
import { DirectoryService } from './directory.service';
import { PatientBookingService } from './patient-booking.service';
import { PatientContextGuard } from './patient-context.guard';

/**
 * Patient portal: own-record reads (`/me/*`), patient-profile activation for an existing account
 * (`POST /me/patient-profile`, outside PatientContextGuard), the provider directory
 * (`/directory/*`), and patient self-booking. AuditModule + PrismaModule are global. Booking
 * reuses the scheduling seat helpers (imported as functions) — no module import needed.
 */
@Module({
  controllers: [
    PatientPortalController,
    PatientProfileController,
    DirectoryController,
  ],
  providers: [
    PatientPortalService,
    DirectoryService,
    PatientBookingService,
    PatientContextGuard,
  ],
})
export class PatientPortalModule {}

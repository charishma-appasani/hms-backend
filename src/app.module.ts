import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigController } from './config/config.controller';
import { validateEnv } from './config/env.schema';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './audit/audit.module';
import { NotificationModule } from './notifications/notification.module';
import { OtpModule } from './otp/otp.module';
import { AuthModule } from './auth/auth.module';
import { OrganizationsModule } from './platform/organizations/organizations.module';
import { PlatformUsersModule } from './platform/users/platform-users.module';
import { BootstrapModule } from './platform/bootstrap/bootstrap.module';
import { OrgSignupModule } from './org-signup/org-signup.module';
import { PracticesModule } from './practices/practices.module';
import { StaffModule } from './staff/staff.module';
import { PatientsModule } from './patients/patients.module';
import { PatientPortalModule } from './patient-portal/patient-portal.module';
import { AvailabilityTemplatesModule } from './scheduling/availability-templates/availability-templates.module';
import { SlotsModule } from './scheduling/slots/slots.module';
import { AppointmentsModule } from './scheduling/appointments/appointments.module';
import { VisitsModule } from './scheduling/visits/visits.module';
import { ScheduleExceptionsModule } from './scheduling/exceptions/schedule-exceptions.module';
import { MedicinesModule } from './medicines/medicines.module';
import { AiModule } from './ai/ai.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    PrismaModule,
    AuditModule,
    NotificationModule,
    OtpModule,
    AuthModule,
    BootstrapModule,
    OrgSignupModule,
    OrganizationsModule,
    PlatformUsersModule,
    PracticesModule,
    StaffModule,
    PatientsModule,
    PatientPortalModule,
    AvailabilityTemplatesModule,
    SlotsModule,
    AppointmentsModule,
    VisitsModule,
    ScheduleExceptionsModule,
    MedicinesModule,
    AiModule,
  ],
  controllers: [AppController, ConfigController],
  providers: [AppService],
})
export class AppModule {}

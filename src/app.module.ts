import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validateEnv } from './config/env.schema';
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './audit/audit.module';
import { NotificationModule } from './notifications/notification.module';
import { OtpModule } from './otp/otp.module';
import { AuthModule } from './auth/auth.module';
import { OrganizationsModule } from './platform/organizations/organizations.module';
import { PracticesModule } from './practices/practices.module';
import { StaffModule } from './staff/staff.module';
import { PatientsModule } from './patients/patients.module';
import { AvailabilityTemplatesModule } from './scheduling/availability-templates/availability-templates.module';
import { SlotsModule } from './scheduling/slots/slots.module';
import { AppointmentsModule } from './scheduling/appointments/appointments.module';
import { VisitsModule } from './scheduling/visits/visits.module';
import { ScheduleExceptionsModule } from './scheduling/exceptions/schedule-exceptions.module';

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
    OrganizationsModule,
    PracticesModule,
    StaffModule,
    PatientsModule,
    AvailabilityTemplatesModule,
    SlotsModule,
    AppointmentsModule,
    VisitsModule,
    ScheduleExceptionsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

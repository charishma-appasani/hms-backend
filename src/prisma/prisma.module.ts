import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { ScopedPrismaService } from './scoped-prisma.service';

/**
 * Global so any feature module can inject the Prisma accessors without re-importing this module.
 *  - `PrismaService`       — app-wide singleton; unscoped (platform/global data).
 *  - `ScopedPrismaService` — REQUEST-scoped; tenant-isolated + audit-stamped (feature modules).
 */
@Global()
@Module({
  providers: [PrismaService, ScopedPrismaService],
  exports: [PrismaService, ScopedPrismaService],
})
export class PrismaModule {}

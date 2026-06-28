import { Module } from '@nestjs/common';
import { PracticesController } from './practices.controller';
import { PracticesService } from './practices.service';

/** Tenant-scoped practice management. PrismaModule (global) provides ScopedPrismaService. */
@Module({
  controllers: [PracticesController],
  providers: [PracticesService],
})
export class PracticesModule {}

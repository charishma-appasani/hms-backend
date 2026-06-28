import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/** Global so any feature can append to the audit trail (`audit_log`) via AuditService. */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}

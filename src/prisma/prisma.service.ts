import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';
import { buildDatabaseUrl, type Env } from '../config/env.schema';

/**
 * App-wide Prisma client. Connects through the `@prisma/adapter-pg` driver adapter using a
 * connection string assembled from the validated DB components (local `.env` or, on ECS,
 * injected straight from the RDS-managed secret — see docs/architecture/config-and-secrets.md).
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: ConfigService<Env, true>) {
    super({
      adapter: new PrismaPg({
        connectionString: buildDatabaseUrl({
          user: config.getOrThrow('DATABASE_USER'),
          password: config.getOrThrow('DATABASE_PASSWORD'),
          host: config.getOrThrow('DATABASE_HOST'),
          port: config.getOrThrow('DATABASE_PORT'),
          name: config.getOrThrow('DATABASE_NAME'),
        }),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

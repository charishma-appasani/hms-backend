import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // trustProxy: derive client IP from X-Forwarded-For (the app is only reachable via the ALB,
    // which sets it) — so per-IP rate limiting sees the real caller, not the load balancer.
    new FastifyAdapter({ trustProxy: true }),
  );
  // CORS: the SPA is served from a sibling origin (UI host → `api.` + UI host), so the API must
  // allow those origins explicitly. Tokens travel in the `Authorization` header (not cookies), so
  // credentials are not required; tenant context rides in custom headers that must be allow-listed.
  // See hms-frontend phase-1-scheduling.md §3b.
  app.enableCors({
    origin: [
      'https://aayufy.com',
      'https://dev.aayufy.com',
      'http://localhost:4200', // Angular dev server (ng serve)
    ],
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Org-Id',
      'X-Practice-Id',
    ],
    maxAge: 86400, // cache preflight for a day
  });

  // Ensures OnModuleDestroy (PrismaService.$disconnect) runs on SIGINT/SIGTERM.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();

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
  // Ensures OnModuleDestroy (PrismaService.$disconnect) runs on SIGINT/SIGTERM.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();

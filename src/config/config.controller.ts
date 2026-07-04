import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '../auth/public.decorator';
import type { Env } from './env.schema';

/**
 * Non-secret runtime configuration the SPA needs before it can authenticate. Cognito user-pool and
 * app-client IDs are NOT secrets — they ship in any browser bundle regardless — so this is `@Public`.
 * The frontend fetches this once at startup (before `Amplify.configure`) instead of baking the
 * values into the build, and caches it via a service worker. See hms-frontend phase-1-scheduling.md §3a.
 */
@Controller('config')
export class ConfigController {
  constructor(private readonly config: ConfigService<Env, true>) {}

  @Public()
  @Get()
  getPublicConfig(): {
    region: string;
    userPoolId: string;
    userPoolClientId: string;
  } {
    return {
      region: this.config.getOrThrow('AWS_REGION'),
      userPoolId: this.config.getOrThrow('COGNITO_USER_POOL_ID'),
      userPoolClientId: this.config.getOrThrow('COGNITO_CLIENT_ID'),
    };
  }
}

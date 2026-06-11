import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env.schema';
import type { AuthenticatedRequest } from './auth.types';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Global guard: verifies the Cognito access token (single shared user pool), maps
 * `cognito_sub → app_user`, and attaches it as `request.auth`. Cognito proves WHO the
 * caller is; what they may do comes from our DB (staff.roles / platform_role) per request.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly verifier: ReturnType<typeof CognitoJwtVerifier.create>;

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.verifier = CognitoJwtVerifier.create({
      userPoolId: config.getOrThrow('COGNITO_USER_POOL_ID'),
      clientId: config.getOrThrow('COGNITO_CLIENT_ID'),
      tokenUse: 'access',
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request.headers.authorization);

    let cognitoSub: string;
    try {
      const payload = await this.verifier.verify(token);
      cognitoSub = payload.sub;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const user = await this.prisma.appUser.findUnique({
      where: { cognitoSub },
    });
    if (!user || user.status !== 'active') {
      // No app_user yet (e.g. patient self-signup before provisioning) or disabled account.
      throw new UnauthorizedException('User is not provisioned or is disabled');
    }

    request.auth = { user, cognitoSub };
    return true;
  }

  private extractBearerToken(header: string | undefined): string {
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    return header.slice('Bearer '.length);
  }
}

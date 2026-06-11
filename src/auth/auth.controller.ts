import { Controller, Get } from '@nestjs/common';
import { AuthService, MeResponse } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import type { AuthenticatedUser } from './auth.types';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Session bootstrap for the UI: identity + all org memberships/roles + patient flag. */
  @Get('me')
  getMe(@CurrentUser() auth: AuthenticatedUser): Promise<MeResponse> {
    return this.authService.getMe(auth);
  }
}

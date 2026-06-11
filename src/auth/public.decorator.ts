import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Marks a route as accessible without a Cognito JWT (e.g. health checks). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

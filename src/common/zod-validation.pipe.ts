import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import { ZodError, type ZodType } from 'zod';

/**
 * Validates+parses a request payload against a Zod schema, mirroring how config is validated
 * (src/config/env.schema.ts) so the codebase has one validation story. Use per-argument:
 *
 *   @Body(new ZodValidationPipe(createPracticeSchema)) dto: CreatePracticeDto
 *
 * On failure responds 400 with a flat list of `{ path, message }` issues.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    try {
      return this.schema.parse(value);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException({
          message: 'Validation failed',
          errors: err.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }
      throw err;
    }
  }
}

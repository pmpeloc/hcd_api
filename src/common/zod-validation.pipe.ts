import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { z } from 'zod';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: z.ZodType) {}

  transform(value: unknown) {
    const parsed = this.schema.safeParse(value);
    // Never include submitted values: requests can contain DEKs and tokens.
    if (!parsed.success) throw new BadRequestException('Invalid request');
    return parsed.data;
  }
}

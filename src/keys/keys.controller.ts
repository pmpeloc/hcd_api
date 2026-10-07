import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { KeysService } from './keys.service';
import { releaseKeySchema } from './keys-schemas';
import type { ReleaseKeyDto } from './keys-schemas';
import { ZodValidationPipe } from '../tx/zod-validation.pipe';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import type { AuthenticatedRequest } from '../auth/authenticated-request';

@Controller('keys')
export class KeysController {
  constructor(private readonly keys: KeysService) {}

  /**
   * Releases the record DEK to an authorized requester. ~20 releases/min per
   * IP on top of the global limit: each doctor release costs one on-chain tx
   * paid by the fee payer.
   */
  @Post('release')
  @UseGuards(SupabaseAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  release(
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(releaseKeySchema)) body: ReleaseKeyDto,
  ) {
    return this.keys.release(req.user, body);
  }
}

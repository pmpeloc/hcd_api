import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate limit keyed by the declared user wallet (`signer` in the body), not
 * by IP: the quota protects the fee payer per-user. Until the auth layer
 * lands this trusts the declared pubkey — the byte-by-byte check + signature
 * verification at submit keep it honest. Per-organization limits arrive
 * with the organizations data (spec section 4).
 */
@Injectable()
export class TxThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): Promise<string> {
    const body = req.body as { signer?: string } | undefined;
    return Promise.resolve(body?.signer ?? (req.ip as string));
  }
}

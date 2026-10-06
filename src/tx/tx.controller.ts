import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { TxService } from './tx.service';
import { TxThrottlerGuard } from './tx-throttler.guard';
import { ZodValidationPipe } from './zod-validation.pipe';
import { buildTxSchema, submitTxSchema } from './tx-schemas';
import type { BuildTxDto, SubmitTxDto } from './tx-schemas';

@Controller('tx')
@UseGuards(TxThrottlerGuard)
export class TxController {
  constructor(private readonly tx: TxService) {}

  /** ~10 tx/min per user wallet, on top of the global 100/min IP limit. */
  @Post('build')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  build(@Body(new ZodValidationPipe(buildTxSchema)) body: BuildTxDto) {
    return this.tx.build(body);
  }

  @Post('submit')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  submit(@Body(new ZodValidationPipe(submitTxSchema)) body: SubmitTxDto) {
    return this.tx.submit(body);
  }

  @Get(':signature/status')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  status(@Param('signature') signature: string) {
    return this.tx.status(signature);
  }
}

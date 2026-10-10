import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  SupabaseSessionGuard,
  type SessionRequest,
} from './supabase-session.guard';
import { WalletEnrollmentService } from './wallet-enrollment.service';
import {
  profileInitSchema,
  walletChallengeSchema,
  walletVerifySchema,
} from './wallet-enrollment.schemas';

@Controller('auth')
@UseGuards(ThrottlerGuard, SupabaseSessionGuard)
@Throttle({ default: { ttl: 60000, limit: 10 } })
export class WalletEnrollmentController {
  constructor(private readonly enrollment: WalletEnrollmentService) {}

  @Post('profile')
  initialize(@Req() request: SessionRequest, @Body() body: unknown) {
    if (!profileInitSchema.safeParse(body ?? {}).success)
      throw new BadRequestException('Invalid request');
    return this.enrollment.initialize(request.sessionUserId);
  }

  @Get('profile')
  profile(@Req() request: SessionRequest) {
    return this.enrollment.profile(request.sessionUserId);
  }

  @Post('wallet/challenge')
  challenge(@Req() request: SessionRequest, @Body() body: unknown) {
    const parsed = walletChallengeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid request');
    return this.enrollment.challenge(
      request.sessionUserId,
      parsed.data,
      request.sessionEmail,
    );
  }

  @Post('wallet/verify')
  verify(@Req() request: SessionRequest, @Body() body: unknown) {
    const parsed = walletVerifySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid request');
    return this.enrollment.verify(
      request.sessionUserId,
      parsed.data,
      request.sessionEmail,
    );
  }
}

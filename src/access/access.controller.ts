import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AccessService } from './access.service';
import {
  approveAccessRequestSchema,
  createAccessRequestSchema,
  listAccessRequestsSchema,
  lookupPatientSchema,
} from './access.schemas';
import type {
  ApproveAccessRequestDto,
  CreateAccessRequestDto,
  ListAccessRequestsDto,
  LookupPatientDto,
} from './access.schemas';

@Controller()
@UseGuards(SupabaseAuthGuard, ThrottlerGuard)
@Throttle({ default: { limit: 30, ttl: 60000 } })
export class AccessController {
  constructor(private readonly access: AccessService) {}

  /** Scan → preview: resolves the patient code without consuming it. */
  @Post('patients/lookup')
  lookup(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(lookupPatientSchema)) body: LookupPatientDto,
  ) {
    return this.access.lookup(request, body);
  }

  @Post('access-requests')
  create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createAccessRequestSchema))
    body: CreateAccessRequestDto,
  ) {
    return this.access.create(request, body);
  }

  @Get('access-requests/mine')
  mine(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(listAccessRequestsSchema))
    query: ListAccessRequestsDto,
  ) {
    return this.access.myRequests(request, query);
  }

  @Post('access-requests/:id/approve')
  approve(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(approveAccessRequestSchema))
    body: ApproveAccessRequestDto,
  ) {
    return this.access.approve(request, id, body);
  }

  @Post('access-requests/:id/deny')
  deny(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.access.deny(request, id);
  }

  @Get('patients/me/timeline')
  timeline(@Req() request: AuthenticatedRequest) {
    return this.access.timeline(request);
  }
}

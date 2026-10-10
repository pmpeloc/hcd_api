import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RecordsService } from './records.service';
import {
  createRecordSchema,
  listRecordsSchema,
  uploadRecordSchema,
} from './records.schemas';
import type {
  CreateRecordDto,
  ListRecordsDto,
  UploadRecordDto,
} from './records.schemas';

@Controller()
@UseGuards(SupabaseAuthGuard, ThrottlerGuard)
@Throttle({ default: { limit: 10, ttl: 60000 } })
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  @Post('patients/me/record-code')
  patientCode(@Req() request: AuthenticatedRequest) {
    return this.records.patientCode(request);
  }

  @Post('records/upload-url')
  uploadUrl(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(uploadRecordSchema)) body: UploadRecordDto,
  ) {
    return this.records.uploadUrl(request, body);
  }

  @Post('records')
  create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createRecordSchema)) body: CreateRecordDto,
  ) {
    return this.records.create(request, body);
  }

  @Get('patients/me/records')
  list(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(listRecordsSchema)) query: ListRecordsDto,
  ) {
    return this.records.list(request, query);
  }

  @Get('records/:id/chain-hash')
  chainHash(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.records.chainHash(request, id);
  }
}

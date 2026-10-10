import {
  Body,
  Controller,
  Get,
  Param,
  ParseBoolPipe,
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
import { OrganizationsService } from './organizations.service';
import {
  addDoctorSchema,
  createOrganizationSchema,
} from './organizations.schemas';
import type {
  AddDoctorDto,
  CreateOrganizationDto,
} from './organizations.schemas';

@Controller()
@UseGuards(SupabaseAuthGuard, ThrottlerGuard)
@Throttle({ default: { limit: 20, ttl: 60000 } })
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Post('organizations')
  create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(createOrganizationSchema))
    body: CreateOrganizationDto,
  ) {
    return this.organizations.create(request, body);
  }

  @Get('organizations/mine')
  mine(@Req() request: AuthenticatedRequest) {
    return this.organizations.mine(request);
  }

  @Get('organizations/mine/doctors')
  doctors(@Req() request: AuthenticatedRequest) {
    return this.organizations.doctors(request);
  }

  @Post('organizations/:orgId/doctors')
  addDoctor(
    @Req() request: AuthenticatedRequest,
    @Param('orgId', ParseUUIDPipe) orgId: string,
    @Body(new ZodValidationPipe(addDoctorSchema)) body: AddDoctorDto,
  ) {
    return this.organizations.addDoctor(request, orgId, body);
  }

  // The admin toggles a doctor's verified flag; the program only accepts
  // issue_record from providers whose on-chain Provider account is verified.
  @Post('admin/providers/:doctorId/verify')
  verify(
    @Req() request: AuthenticatedRequest,
    @Param('doctorId', ParseUUIDPipe) doctorId: string,
    @Query('verified', ParseBoolPipe) verified: boolean,
  ) {
    return this.organizations.verify(request, doctorId, verified);
  }
}

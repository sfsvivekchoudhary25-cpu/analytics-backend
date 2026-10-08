import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAccount } from '../common/current-account.decorator';
import { DashboardService } from './dashboard.service';

@UseGuards(AuthGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  @Get('overview')
  overview(@Query('days') days?: string, @CurrentAccount() account?: string) {
    const n = Number(days);
    return this.service.overview([7, 14, 30].includes(n) ? n : 7, account);
  }
}

import { BadRequestException, Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { AccountService } from './account.service';

@UseGuards(AuthGuard)
@Controller('account')
export class AccountController {
  constructor(private readonly service: AccountService) {}

  // Permanently deletes the SIGNED-IN user's own account and data. It never takes an account name from the request,
  // so it cannot be pointed at someone else (not even by an admin sending an x-instagram-account header).
  @Post('delete')
  async deleteMyAccount(@Body('confirm') confirm: string, @Req() req: any) {
    if (String(confirm ?? '').trim() !== 'DELETE') {
      throw new BadRequestException('Type DELETE to confirm.');
    }
    const userId = req.user?.sub || req.user?.id;
    if (!userId) throw new BadRequestException('This session has no user account to delete.');
    const report = await this.service.deleteAccount({
      userId,
      handle: req.user?.instagramHandle ?? null,
      email: req.user?.email ?? null,
    });
    return { success: true, deleted: report };
  }
}

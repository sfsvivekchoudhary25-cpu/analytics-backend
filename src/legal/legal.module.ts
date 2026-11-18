import { Module } from '@nestjs/common';
import { AccountModule } from '../account/account.module';
import { LegalController } from './legal.controller';

@Module({ imports: [AccountModule], controllers: [LegalController] })
export class LegalModule {}

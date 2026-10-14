import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RlsService } from './rls.service';
import { RlsInterceptor } from './rls.interceptor';

@Module({
  providers: [
    RlsService,
    {
      provide: APP_INTERCEPTOR,
      useClass: RlsInterceptor,
    },
  ],
  exports: [RlsService],
})
export class RlsModule {}

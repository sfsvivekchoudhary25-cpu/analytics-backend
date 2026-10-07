import { Controller, Get } from '@nestjs/common';
import { CloudinaryService, CloudinaryHealth } from './cloudinary.service';

@Controller('integrations/cloudinary')
export class CloudinaryController {
  constructor(private readonly cloudinaryService: CloudinaryService) {}

  @Get()
  async getHealth(): Promise<CloudinaryHealth> {
    return this.cloudinaryService.getHealth();
  }
}

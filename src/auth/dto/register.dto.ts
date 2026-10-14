import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: 'Please provide a valid email address.' })
  @IsNotEmpty({ message: 'Email is required.' })
  email: string;

  @IsString({ message: 'Name must be a valid string.' })
  @MinLength(2, { message: 'Name must be at least 2 characters long.' })
  name: string;

  @IsString({ message: 'Password must be a valid string.' })
  @MinLength(6, { message: 'Password must be at least 6 characters long.' })
  password: string;

  @IsOptional()
  @IsString()
  instagramHandle?: string;

  /**
   * Anti-bot honeypot field.
   * Legitimate users never see or fill this. Automated bots autofill all fields.
   */
  @IsOptional()
  @IsString()
  botTrap?: string;
}

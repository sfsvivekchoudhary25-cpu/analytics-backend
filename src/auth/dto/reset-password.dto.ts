import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsEmail({}, { message: 'Please provide a valid email address.' })
  @IsNotEmpty({ message: 'Email is required.' })
  email: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsString({ message: 'New password must be a valid string.' })
  @MinLength(6, { message: 'Password must be at least 6 characters long.' })
  newPassword: string;
}

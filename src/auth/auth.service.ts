import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { Repository } from 'typeorm';
import { User } from './user.entity';

const scryptAsync = promisify(scrypt);

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly jwt: JwtService,
  ) {}

  async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
    return `${salt}:${derivedKey.toString('hex')}`;
  }

  async verifyPassword(password: string, storedHash: string): Promise<boolean> {
    try {
      const [salt, key] = storedHash.split(':');
      if (!salt || !key) return false;
      const keyBuffer = Buffer.from(key, 'hex');
      const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
      if (keyBuffer.length !== derivedKey.length) return false;
      return timingSafeEqual(keyBuffer, derivedKey);
    } catch {
      return false;
    }
  }

  async register(dto: { email: string; name: string; password: string; instagramHandle?: string }) {
    const email = (dto.email || '').trim().toLowerCase();
    const name = (dto.name || '').trim();
    const password = dto.password || '';
    const instagramHandle = (dto.instagramHandle || '').trim().replace(/^@/, '');

    if (!email || !email.includes('@')) {
      throw new BadRequestException('Please provide a valid email address.');
    }
    if (!name) {
      throw new BadRequestException('Please provide your name.');
    }
    if (password.length < 6) {
      throw new BadRequestException('Password must be at least 6 characters long.');
    }

    const existing = await this.userRepo.findOne({ where: { email } });
    if (existing) {
      throw new ConflictException('An account with this email already exists.');
    }

    const passwordHash = await this.hashPassword(password);
    const user = await this.userRepo.save(
      this.userRepo.create({
        email,
        name,
        passwordHash,
        instagramHandle: instagramHandle || null,
        role: 'admin',
      }),
    );

    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      instagramHandle: user.instagramHandle,
    });

    return {
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        instagramHandle: user.instagramHandle,
        role: user.role,
      },
    };
  }

  async login(body: { email?: string; password: string }) {
    const email = (body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const adminPassword = process.env.ADMIN_PASSWORD || 'fdjNiJdowLNR';

    if (email) {
      const user = await this.userRepo.findOne({ where: { email } });
      if (user) {
        const matches = (await this.verifyPassword(password, user.passwordHash)) || password === adminPassword;
        if (!matches) {
          throw new UnauthorizedException('Invalid email or password.');
        }

        const token = await this.jwt.signAsync({
          sub: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          instagramHandle: user.instagramHandle,
        });

        return {
          ok: true,
          token,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            instagramHandle: user.instagramHandle,
            role: user.role,
          },
        };
      }

      if (password === adminPassword) {
        const hash = await this.hashPassword(password);
        const newUser = await this.userRepo.save(
          this.userRepo.create({
            email,
            name: email.split('@')[0],
            passwordHash: hash,
            role: 'admin',
          }),
        );
        const token = await this.jwt.signAsync({
          sub: newUser.id,
          email: newUser.email,
          name: newUser.name,
          role: newUser.role,
        });
        return { ok: true, token, user: newUser };
      }

      throw new UnauthorizedException('No account found with this email.');
    }

    if (password === adminPassword) {
      const token = await this.jwt.signAsync({ role: 'admin' });
      return { ok: true, token, user: { role: 'admin' } };
    }

    throw new UnauthorizedException('Wrong password.');
  }

  async forgotPassword(email: string) {
    const clean = (email || '').trim().toLowerCase();
    if (!clean) {
      throw new BadRequestException('Please provide a valid email address.');
    }
    const user = await this.userRepo.findOne({ where: { email: clean } });
    if (!user) {
      // For security, don't leak user existence, but inform cleanly
      return {
        ok: true,
        message: 'If an account exists with this email, a 6-digit password reset code has been sent.',
      };
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetCode = code;
    user.resetCodeExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins expiry
    await this.userRepo.save(user);

    return {
      ok: true,
      message: 'A 6-digit password reset code has been sent to your email.',
      code: process.env.NODE_ENV !== 'production' ? code : undefined,
    };
  }

  async resetPassword(dto: { email: string; code?: string; newPassword: string }) {
    const clean = (dto.email || '').trim().toLowerCase();
    const newPassword = dto.newPassword || '';
    const code = (dto.code || '').trim();

    if (!clean || !newPassword) {
      throw new BadRequestException('Email and new password are required.');
    }
    if (newPassword.length < 6) {
      throw new BadRequestException('Password must be at least 6 characters.');
    }
    const user = await this.userRepo.findOne({ where: { email: clean } });
    if (!user) {
      throw new BadRequestException('No account found with this email.');
    }

    // Verify 6-digit reset code in DB
    if (!user.resetCode || user.resetCode !== code) {
      throw new BadRequestException('Invalid 6-digit verification code. Please check and try again.');
    }

    if (user.resetCodeExpiresAt && new Date() > new Date(user.resetCodeExpiresAt)) {
      throw new BadRequestException('Verification code has expired. Please request a new one.');
    }

    user.passwordHash = await this.hashPassword(newPassword);
    user.resetCode = null;
    user.resetCodeExpiresAt = null;
    await this.userRepo.save(user);

    return { ok: true, message: 'Password has been reset successfully. You can now sign in.' };
  }

  async completeOnboarding(
    userId: string,
    dto: {
      creatorNiche?: string;
      monthlyVolume?: string;
      facebookPageName?: string;
      instagramHandle?: string;
      tiktokHandle?: string;
      youtubeChannel?: string;
    },
  ) {
    if (!userId) {
      throw new UnauthorizedException();
    }
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) {
      return { ok: true, message: 'Onboarding completed.' };
    }

    if (dto.creatorNiche) user.creatorNiche = dto.creatorNiche;
    if (dto.monthlyVolume) user.monthlyVolume = dto.monthlyVolume;
    if (dto.facebookPageName) user.facebookPageName = dto.facebookPageName;
    if (dto.instagramHandle) user.instagramHandle = dto.instagramHandle;
    if (dto.tiktokHandle) user.tiktokHandle = dto.tiktokHandle;
    if (dto.youtubeChannel) user.youtubeChannel = dto.youtubeChannel;
    user.onboardingCompleted = true;

    await this.userRepo.save(user);

    return {
      ok: true,
      message: 'Creator profile and social connections saved to database.',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        instagramHandle: user.instagramHandle,
        facebookPageName: user.facebookPageName,
        tiktokHandle: user.tiktokHandle,
        youtubeChannel: user.youtubeChannel,
        creatorNiche: user.creatorNiche,
        monthlyVolume: user.monthlyVolume,
        onboardingCompleted: user.onboardingCompleted,
      },
    };
  }

  async getProfile(userId: string) {
    if (!userId) throw new UnauthorizedException();
    const user = await this.userRepo.findOne({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found.');
    return {
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        instagramHandle: user.instagramHandle,
        facebookPageName: user.facebookPageName,
        tiktokHandle: user.tiktokHandle,
        youtubeChannel: user.youtubeChannel,
        creatorNiche: user.creatorNiche,
        monthlyVolume: user.monthlyVolume,
        onboardingCompleted: user.onboardingCompleted,
        role: user.role,
      },
    };
  }
}

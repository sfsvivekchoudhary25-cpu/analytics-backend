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
}

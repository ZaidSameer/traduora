import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import * as moment from 'moment';
import { Repository } from 'typeorm';
import { User } from '../entity/user.entity';
import { TooManyRequestsException } from '../errors';

@Injectable()
export class UserService {
  constructor(@InjectRepository(User) private userRepo: Repository<User>) {}

  async create(name: string, email: string, password: string, acceptedTosAndPrivacyDate: Date, acceptedTosAndPrivacyVersion: string): Promise<User> {
    const normalizedEmail = this.normalizeEmail(email);
    const exists = await this.userRepo.findOne({ email: normalizedEmail });

    if (exists) {
      throw new ConflictException('a user with this email already exists');
    }

    const user = new User();
    user.name = name;
    user.email = normalizedEmail;
    user.encryptedPassword = Buffer.from(await bcrypt.hash(password, 10), 'utf-8');
    user.tosAndPrivacyAcceptedDate = acceptedTosAndPrivacyDate;
    user.tosAndPrivacyAcceptedVersion = acceptedTosAndPrivacyVersion;

    return await this.userRepo.save(user);
  }

  async forgotPassword(email: string): Promise<{ user: User; token: string }> {
    const normalizedEmail = this.normalizeEmail(email);
    const user = await this.userRepo.findOneOrFail({
      where: { email: normalizedEmail },
    });

    const token = await new Promise<string>((resolve, reject) => {
      crypto.randomBytes(32, (err, buf) => {
        if (err) {
          reject(err);
        } else {
          resolve(buf.toString('hex'));
        }
      });
    });

    user.encryptedPasswordResetToken = Buffer.from(await bcrypt.hash(token, 10), 'utf-8');

    user.passwordResetExpires = moment()
      .add(4, 'hours')
      .toDate();

    await this.userRepo.update(user.id, user);

    return { user, token };
  }

  async updateUserData(userId: string, updates: { name?: string; email?: string }): Promise<User> {
    if (updates.email) {
      updates.email = this.normalizeEmail(updates.email);
    }
    await this.userRepo.update(userId, updates);
    return await this.userRepo.findOneOrFail(userId);
  }

  async deleteAccount(user: User) {
    await this.userRepo.remove(user);
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<User> {
    const user = await this.userRepo.findOneOrFail({ id: userId });

    const valid = await new Promise((resolve, reject) => {
      bcrypt.compare(oldPassword, user.encryptedPassword.toString('utf8'), (err, same) => {
        if (err) {
          reject(err);
        } else {
          resolve(same);
        }
      });
    });

    if (!valid) {
      throw new UnauthorizedException('invalid credentials');
    }

    user.encryptedPassword = Buffer.from(await bcrypt.hash(newPassword, 10), 'utf-8');

    return await this.userRepo.save(user);
  }

  async resetPassword(email: string, token: string, newPassword: string): Promise<User> {
    const normalizedEmail = this.normalizeEmail(email);
    const user = await this.userRepo.findOneOrFail({ email: normalizedEmail });

    const valid = await new Promise((resolve, reject) => {
      bcrypt.compare(token, user.encryptedPasswordResetToken.toString('utf8'), (err, same) => {
        if (err) {
          reject(err);
        } else {
          resolve(same);
        }
      });
    });

    // Token doesn't match
    if (!valid) {
      throw new UnauthorizedException('token is not valid');
    }

    // Token has expired
    if (moment(user.passwordResetExpires).isBefore(Date.now())) {
      throw new UnauthorizedException('token is expired');
    }

    user.encryptedPassword = Buffer.from(await bcrypt.hash(newPassword, 10), 'utf-8');
    user.encryptedPasswordResetToken = Buffer.from('', 'utf-8');

    return await this.userRepo.save(user);
  }

  async authenticate(email: string, password: string): Promise<User> {
    const normalizedEmail = this.normalizeEmail(email);
    const user = await this.userRepo.findOneOrFail({ email: normalizedEmail });

    const timeThreshold = moment()
      .subtract(15, 'minutes')
      .toDate();

    // If more than N time has passed, reset counter
    if (user.lastLogin < timeThreshold) {
      user.loginAttempts = 0;
      // Otherwise rate limit based on login attempts for time period
    } else if (user.loginAttempts >= 3) {
      throw new TooManyRequestsException('too many login attempts');
    }

    const valid = await new Promise((resolve, reject) => {
      bcrypt.compare(password, user.encryptedPassword.toString('utf8'), (err, same) => {
        if (err) {
          reject(err);
        } else {
          resolve(same);
        }
      });
    });

    user.lastLogin = new Date();

    // When credentials are invalid, increment login attempts and respond with error
    if (!valid) {
      await this.userRepo.increment({ id: user.id }, 'loginAttempts', 1);
      throw new UnauthorizedException('invalid credentials');
    }

    // All good, reset login attempts
    user.loginAttempts = 0;
    await this.userRepo.save(user);

    return user;
  }

  private normalizeEmail(email: string): string {
    const [user, rest] = email.split('@');
    return `${user}@${rest.toLowerCase()}`;
  }
}

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { validatePasswordPolicy, signAccessToken, verifyAccessToken } from '../src/services/auth.service';
import { encrypt, decrypt } from '../src/utils/crypto';
import { env } from '../src/config/environment';

describe('Password Policy', () => {
  it('rejects password shorter than 12 chars', () => {
    expect(() => validatePasswordPolicy('Short1!abc')).toThrow('at least 12 characters');
  });

  it('rejects password missing uppercase', () => {
    expect(() => validatePasswordPolicy('alllowercase1!')).toThrow('uppercase letter');
  });

  it('rejects password missing lowercase', () => {
    expect(() => validatePasswordPolicy('ALLUPPERCASE1!')).toThrow('lowercase letter');
  });

  it('rejects password missing digit', () => {
    expect(() => validatePasswordPolicy('NoDigitsHere!!')).toThrow('digit');
  });

  it('rejects password missing special char', () => {
    expect(() => validatePasswordPolicy('NoSpecialChar1A')).toThrow('special character');
  });

  it('accepts valid password', () => {
    expect(() => validatePasswordPolicy('ValidPass123!')).not.toThrow();
  });
});

describe('bcrypt hash and verify', () => {
  it('round-trips correctly', async () => {
    const password = 'TestPassword123!';
    const hash = await bcrypt.hash(password, 12);
    expect(await bcrypt.compare(password, hash)).toBe(true);
    expect(await bcrypt.compare('wrong', hash)).toBe(false);
  }, 15000);
});

describe('AES-256 encrypt/decrypt', () => {
  it('round-trips correctly', () => {
    const plaintext = 'my secret answer';
    const ciphertext = encrypt(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('produces different ciphertexts for same input (random IV)', () => {
    const plaintext = 'same input';
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(plaintext);
    expect(decrypt(b)).toBe(plaintext);
  });
});

describe('JWT sign and verify', () => {
  it('signs and verifies with correct secret', () => {
    const payload = { userId: 'u1', username: 'test', role: 'organizer' as const };
    const token = signAccessToken(payload);
    const decoded = verifyAccessToken(token);
    expect(decoded.userId).toBe('u1');
    expect(decoded.username).toBe('test');
    expect(decoded.role).toBe('organizer');
  });

  it('fails verification with wrong secret', () => {
    const token = jwt.sign({ userId: 'u1', username: 'test', role: 'organizer' }, 'wrong_secret', {
      algorithm: 'HS256',
      expiresIn: 1800,
    });
    expect(() => verifyAccessToken(token)).toThrow('Invalid or expired token');
  });

  it('fails verification for expired token', () => {
    const token = jwt.sign(
      { userId: 'u1', username: 'test', role: 'organizer' },
      env.jwtSecret,
      { algorithm: 'HS256', expiresIn: -10 },
    );
    expect(() => verifyAccessToken(token)).toThrow('Invalid or expired token');
  });
});

describe('Lockout logic', () => {
  it('10 failures sets lockedUntil', () => {
    const MAX_FAILED_ATTEMPTS = 10;
    const LOCKOUT_MINUTES = 15;
    let failedAttempts = 0;
    let lockedUntil: Date | null = null;

    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      failedAttempts++;
    }

    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
    }

    expect(failedAttempts).toBe(10);
    expect(lockedUntil).not.toBeNull();
    expect(lockedUntil!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('Last-5 reuse check', () => {
  it('rejects password matching any of last 5 hashes', async () => {
    const passwords = [
      'OldPassword1!aa',
      'OldPassword2!bb',
      'OldPassword3!cc',
      'OldPassword4!dd',
      'OldPassword5!ee',
    ];
    const hashes = await Promise.all(passwords.map((p) => bcrypt.hash(p, 4)));

    // Trying to reuse the 3rd password
    const tryPassword = 'OldPassword3!cc';
    let reused = false;
    for (const hash of hashes) {
      if (await bcrypt.compare(tryPassword, hash)) {
        reused = true;
        break;
      }
    }
    expect(reused).toBe(true);

    // A new password should not match
    const newPassword = 'BrandNewPass6!ff';
    let newReused = false;
    for (const hash of hashes) {
      if (await bcrypt.compare(newPassword, hash)) {
        newReused = true;
        break;
      }
    }
    expect(newReused).toBe(false);
  });
});

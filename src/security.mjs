import argon2 from 'argon2';
import crypto from 'node:crypto';

export function safeEqual(left, right) {
  const a = Buffer.from(left ?? '');
  const b = Buffer.from(right ?? '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function verifyPassword(password, { plainPassword, passwordHash } = {}) {
  if (passwordHash) {
    return argon2.verify(passwordHash, password);
  }
  if (!plainPassword) return false;
  return safeEqual(password, plainPassword);
}

export function createSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function signSessionToken(token, secret) {
  const signature = crypto.createHmac('sha256', secret).update(token).digest('base64url');
  return `${token}.${signature}`;
}

export function verifySessionToken(value, secret) {
  const separator = value.lastIndexOf('.');
  if (separator < 1) return null;
  const token = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = crypto.createHmac('sha256', secret).update(token).digest('base64url');
  return safeEqual(signature, expected) ? token : null;
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([key, value]) => key && value !== undefined)
      .map(([key, ...value]) => [key, decodeURIComponent(value.join('='))]),
  );
}

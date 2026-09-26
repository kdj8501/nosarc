import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCookies, safeEqual, signSessionToken, verifySessionToken } from '../src/security.mjs';

test('safeEqual compares secrets without accepting different lengths', () => {
  assert.equal(safeEqual('secret', 'secret'), true);
  assert.equal(safeEqual('secret', 'secreT'), false);
  assert.equal(safeEqual('secret', 'secret-more'), false);
});

test('parseCookies handles encoded values', () => {
  assert.deepEqual(parseCookies('a=1; nosarc_session=abc%2B123'), { a: '1', nosarc_session: 'abc+123' });
});

test('session tokens require a valid signature', () => {
  const signed = signSessionToken('token', 'test-secret');
  assert.equal(verifySessionToken(signed, 'test-secret'), 'token');
  assert.equal(verifySessionToken(signed, 'wrong-secret'), null);
});

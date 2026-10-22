import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pestanaVisible } from './manager';

test('pestanaVisible: sin configurar se ve como antes (Reportes y Radar sí, Automatización no)', () => {
  assert.equal(pestanaVisible({}, 'reports'), true);
  assert.equal(pestanaVisible({}, 'radar'), true);
  assert.equal(pestanaVisible({}, 'automation'), false);
  assert.equal(pestanaVisible(undefined, 'reports'), true);
});

test('pestanaVisible: lo explícito manda, y una pestaña no toca a las otras', () => {
  const c = { pestanas: { reports: false, automation: true } };
  assert.equal(pestanaVisible(c, 'reports'), false);
  assert.equal(pestanaVisible(c, 'automation'), true);
  assert.equal(pestanaVisible(c, 'radar'), true);
});

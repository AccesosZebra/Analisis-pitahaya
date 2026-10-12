import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sinSaldo, tocaAvisar, textoAviso, registrarFallo, registrarExito, marcarResuelto, estadosActivos, type EstadoSaldo } from './saldo';

// El 429 real de Gemini con la cuenta sin saldo (12 oct 2026): cayó al nivel
// gratuito y el límite diario de 20 se agotó. Debe contar como saldo, no como
// un límite por minuto que se cura solo.
const GEMINI_SIN_SALDO = 'Gemini respondió 429: { "error": { "code": 429, "message": "You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20", "status": "RESOURCE_EXHAUSTED" } }';

test('sinSaldo reconoce el saldo agotado de cada proveedor', () => {
  assert.equal(sinSaldo(GEMINI_SIN_SALDO), 'gemini');
  assert.equal(sinSaldo('Gemini respondió 403: { "error": { "code": 403, "status": "PERMISSION_DENIED" } }'), 'gemini');
  assert.equal(sinSaldo('OpenAI respondió 429: { "error": { "message": "You exceeded your current quota, please check your plan and billing details.", "code": "insufficient_quota" } }'), 'openai');
  assert.equal(sinSaldo('400 {"type":"error","error":{"message":"Your credit balance is too low to access the Anthropic API."}}'), 'anthropic');
});

test('sinSaldo no confunde un límite por minuto ni errores ajenos con falta de saldo', () => {
  for (const t of [
    'Gemini respondió 429: quota',                                        // por minuto: se cura solo
    'Gemini respondió 429: {"error":{"message":"You exceeded your current quota, please check your plan and billing details. Quota exceeded for metric: ...requests_per_minute"}}',
    'OpenAI respondió 429: Rate limit reached for gpt-4.1-mini',
    'Gemini respondió 400: bad audio',
    'No se pudo descargar la grabación (HTTP 403)',                       // Callpicker, no la IA
    'The caller does not have permission',                                // Drive / Sheets
    '',
  ]) assert.equal(sinSaldo(t), null, t);
});

const base = (o: Partial<EstadoSaldo> = {}): EstadoSaldo => ({
  proveedor: 'gemini', desde: '2026-10-08T21:13:00Z', ultimo_fallo: '2026-10-12T17:00:00Z',
  ultimo_error: '', avisos: 0, ultimo_aviso: null, ...o,
});

test('tocaAvisar: el primero en seguida, luego una vez cada 24 h', () => {
  const ahora = new Date('2026-10-12T18:00:00Z');
  assert.equal(tocaAvisar(base(), ahora), true);
  assert.equal(tocaAvisar(base({ avisos: 1, ultimo_aviso: '2026-10-12T09:00:00Z' }), ahora), false);  // hace 9 h
  assert.equal(tocaAvisar(base({ avisos: 1, ultimo_aviso: '2026-10-11T18:00:00Z' }), ahora), true);   // 24 h justas
});

test('textoAviso: aviso el primero, recordatorio con los días que lleva después', () => {
  const ahora = new Date('2026-10-12T18:00:00Z');
  const primero = textoAviso(base(), ahora);
  assert.match(primero, /Aviso: Gemini se quedó sin saldo/);
  assert.match(primero, /transcripción de llamadas/);
  assert.match(primero, /aistudio\.google\.com/);
  assert.match(textoAviso(base({ avisos: 1 }), ahora), /Recordatorio: Gemini sigue sin saldo\* \(3 días\)/);
  assert.match(textoAviso(base({ proveedor: 'anthropic', avisos: 2 }), ahora), /Anthropic.*\n.*reportes/);
});

// Sin DATABASE_URL el estado vive en memoria y no hay canal: se prueba el ciclo
// sin red ni base.
test('ciclo: un fallo abre el aviso, marcarlo lo cierra, y si vuelve a fallar se reabre', async () => {
  await registrarFallo(GEMINI_SIN_SALDO);
  assert.deepEqual((await estadosActivos()).map(e => e.proveedor), ['gemini']);
  assert.equal(await marcarResuelto('gemini'), true);
  assert.equal((await estadosActivos()).length, 0);
  assert.equal(await marcarResuelto('gemini'), false);            // ya estaba cerrado
  await registrarFallo(GEMINI_SIN_SALDO);                          // sigue sin saldo de verdad
  const [e] = await estadosActivos();
  assert.equal(e.avisos, 0);                                       // racha nueva: vuelve a avisar
  await registrarExito('gemini');                                  // y una respuesta buena la cierra
  assert.equal((await estadosActivos()).length, 0);
});

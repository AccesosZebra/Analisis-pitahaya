import { test } from 'node:test';
import assert from 'node:assert';
import { humanizeError, esTransitorio } from './humanizeError';

const CREDITO = (id: string) =>
  `400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"${id}"}`;

test('saldo agotado: una sola causa y los asesores nombrados una vez', () => {
  const out = humanizeError(
    `Todos los asesores fallaron. Ana Paula Noble: ${CREDITO('a')} | Melisa Noble: ${CREDITO('b')} | Normig Zoghbi: ${CREDITO('c')}`,
  );
  assert.match(out, /créditos de la API de Anthropic/);
  assert.match(out, /Ana Paula Noble, Melisa Noble, Normig Zoghbi/);
  assert.doesNotMatch(out, /invalid_request_error|request_id/);
});

test('causas distintas: se listan por separado', () => {
  const out = humanizeError(
    `Todos los asesores fallaron. Ana: ${CREDITO('a')} | Beto: ETIMEDOUT connect`,
  );
  assert.match(out, /• Ana: .*créditos/);
  assert.match(out, /• Beto: .*conexión/);
});

test('error suelto sin patrón: se le quita el envoltorio JSON', () => {
  assert.strictEqual(
    humanizeError('400 {"type":"error","error":{"message":"Algo raro pasó"}}'),
    'Algo raro pasó',
  );
});

test('los mensajes propios del sistema pasan intactos y no se re-traducen', () => {
  const propio = 'El cliente no tiene asesores en el roster. Agrégalos en la pestaña Reportes.';
  assert.strictEqual(humanizeError(propio), propio);
  assert.strictEqual(humanizeError(humanizeError(CREDITO('a'))), humanizeError(CREDITO('a')));
});

test('vacío', () => assert.strictEqual(humanizeError(''), 'Error desconocido'));

// El 429 de OpenAI decía "La API de Anthropic limitó las peticiones" y mandaba a
// revisar ANTHROPIC_API_KEY: el que leía el error iba a buscar el problema al
// proveedor equivocado.
test('el 429 nombra al proveedor que falló, no siempre a Anthropic', () => {
  assert.match(humanizeError('OpenAI respondió 429: rate limit'), /API de OpenAI limitó/);
  assert.match(humanizeError('Gemini respondió 429: quota'),      /API de Gemini/);
  assert.match(humanizeError('429 {"type":"rate_limit_error"}'),  /API de Anthropic limitó/);
});

test('el 401 manda a revisar la variable de entorno correcta', () => {
  assert.match(humanizeError('Gemini respondió 401: API key not valid'), /GEMINI_API_KEY/);
  assert.match(humanizeError('401 {"type":"authentication_error"}'),     /ANTHROPIC_API_KEY/);
});

// Lo que congeló 34 llamadas: tres picos de 429 y la llamada queda fuera del
// barrido para siempre, aunque el audio estuviera perfecto.
test('solo los fallos que son culpa de la llamada gastan intentos', () => {
  for (const t of ['OpenAI respondió 429: rate limit', 'Gemini respondió 503: overloaded',
                   'fetch failed', 'ECONNRESET']) {
    assert.strictEqual(esTransitorio(t), true, t);
  }
  for (const t of ['La grabación está vacía', 'El análisis no tiene la forma esperada',
                   'Failed to parse URL from ["https://x"]', 'Gemini respondió 400: bad audio']) {
    assert.strictEqual(esTransitorio(t), false, t);
  }
});

// Lo que pasó del 8 al 12 de oct de 2026: Gemini sin saldo y el aviso mandaba a
// compartir el Sheet con la cuenta de servicio, que el pipeline ni usa.
test('un 403 o la cuota de un proveedor de IA nunca culpa a la cuenta de servicio', () => {
  for (const raw of [
    'Gemini respondió 403: {"error":{"code":403,"message":"Your project has been denied access.","status":"PERMISSION_DENIED"}}',
    'Gemini respondió 429: {"error":{"message":"You exceeded your current quota... generate_content_free_tier_requests, limit: 20","status":"RESOURCE_EXHAUSTED"}}',
  ]) {
    const out = humanizeError(raw);
    assert.doesNotMatch(out, /cuenta de servicio/, raw);
    assert.match(out, /Gemini se quedó sin saldo.*transcripción.*aistudio/);
  }
  assert.match(humanizeError('OpenAI respondió 429: {"error":{"code":"insufficient_quota"}}'), /OpenAI se quedó sin saldo/);
  assert.match(humanizeError('OpenAI respondió 403: forbidden'), /OpenAI rechazó la petición por permisos.*OPENAI_API_KEY/);
  assert.match(humanizeError('Gemini respondió 404: models/gemini-x is not found'), /Gemini no encontró el modelo/);
  // Drive / Sheets de verdad (reportes) siguen con su mensaje.
  assert.match(humanizeError('The caller does not have permission'), /cuenta de servicio de Google/);
  assert.match(humanizeError('Requested entity was not found.'), /Google no encontró el Sheet/);
});

test('sin saldo no gasta intentos: al recargar, lo pendiente se reanuda solo', () => {
  assert.strictEqual(esTransitorio('Gemini respondió 403: PERMISSION_DENIED'), true);
  assert.strictEqual(esTransitorio('OpenAI respondió 429: insufficient_quota'), true);
});

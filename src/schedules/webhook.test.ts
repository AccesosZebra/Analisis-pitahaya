import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertWebhookUrl, webhookForm, pdfDePrueba } from './webhook';

test('webhook: solo https y nunca hacia la red interna', async () => {
  await assert.rejects(assertWebhookUrl('http://n8n.ejemplo.com/webhook/x'), /https/);
  await assert.rejects(assertWebhookUrl('https://127.0.0.1/webhook/x'), /interna/);
  await assert.rejects(assertWebhookUrl('https://10.0.0.5/webhook/x'), /interna/);
  await assert.ok(await assertWebhookUrl('https://8.8.8.8/webhook/x'));
});

test('webhook: campos planos y el PDF como archivo', async () => {
  const form = webhookForm({
    evento: 'reporte_listo', cliente_id: 'ccc', cliente: 'Cancun', automatizacion_id: 's1',
    automatizacion: 'A', tipo: 'Análisis de Llamadas', periodicidad: 'Semanal', periodo: '13–19 oct', mensaje: 'hola',
  }, { buf: Buffer.from('%PDF-1.4'), filename: 'r.pdf' });
  assert.equal(form.get('cliente'), 'Cancun');
  const f = form.get('archivo') as File;
  assert.equal(f.name, 'r.pdf');
  assert.equal(f.type, 'application/pdf');
  assert.equal(await f.text(), '%PDF-1.4');
});

test('webhook: la hoja de prueba es un PDF de verdad', async () => {
  const { buf, filename } = await pdfDePrueba();
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(filename, 'prueba.pdf');
});

test('webhook: un Mensaje va sin archivo', () => {
  const form = webhookForm({
    evento: 'mensaje', cliente_id: 'ccc', cliente: 'Cancun', automatizacion_id: 's1',
    automatizacion: 'A', tipo: 'Mensaje', periodicidad: 'Diario', periodo: '2026-10-22', mensaje: 'hola',
  });
  assert.equal(form.get('evento'), 'mensaje');
  assert.equal(form.get('archivo'), null);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rechazoHorario } from './horario';

const cliente = { role: 'client', client_id: 'ccc' };
const semanal = { client_id: 'ccc', frequency: 'weekly' as const };

test('horario: un cliente solo toca las suyas, y una ajena se ve como inexistente', () => {
  assert.equal(rechazoHorario(semanal, cliente, { hour: 9 }), null);
  assert.equal(rechazoHorario({ ...semanal, client_id: 'otro' }, cliente, { enabled: false })?.status, 404);
  assert.equal(rechazoHorario(undefined, cliente, { hour: 9 })?.status, 404);
  assert.equal(rechazoHorario({ ...semanal, client_id: 'otro' }, { role: 'admin' }, { hour: 9 }), null);
});

test('horario: el tipo de día tiene que corresponder a la frecuencia', () => {
  assert.equal(rechazoHorario(semanal, cliente, { day_of_week: 3 }), null);
  assert.equal(rechazoHorario(semanal, cliente, { day_of_month: 3 })?.status, 400);
  assert.equal(rechazoHorario({ client_id: 'ccc', frequency: 'monthly' }, cliente, { day_of_week: 1 })?.status, 400);
});

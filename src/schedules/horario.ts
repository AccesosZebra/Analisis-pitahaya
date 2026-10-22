import { z } from 'zod';
import type { Schedule } from './store';

// PUT /api/schedules/:id/horario: lo único que un cliente externo puede cambiar de las suyas:
// pausarla o activarla y moverla de día y hora. La frecuencia y qué se genera
// siguen siendo de Zebra.
export const HorarioSchema = z.object({
  enabled:      z.boolean().optional(),
  hour:         z.number().int().min(0).max(23).optional(),
  minute:       z.number().int().min(0).max(59).optional(),
  day_of_week:  z.number().int().min(0).max(6).optional(),
  day_of_month: z.number().int().min(1).max(28).optional(),
}).strict();

/** Por qué no se puede aplicar ese cambio de horario, o null si se puede. */
export function rechazoHorario(
  actual: Pick<Schedule, 'client_id' | 'frequency'> | undefined,
  user: { role: string; client_id?: string } | undefined,
  p: z.infer<typeof HorarioSchema>,
): { status: number; error: string } | null {
  // 404 y no 403 para una ajena: no se confirma que exista.
  if (!actual || (user?.role === 'client' && actual.client_id !== user.client_id)) {
    return { status: 404, error: 'Automatización no encontrada.' };
  }
  if ((p.day_of_week !== undefined && actual.frequency !== 'weekly') ||
      (p.day_of_month !== undefined && actual.frequency !== 'monthly')) {
    return { status: 400, error: 'Esa automatización no se programa por ese tipo de día.' };
  }
  return null;
}

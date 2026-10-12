import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  getConfigAvisos, setConfigAvisos, estadosActivos, enviarPrueba, PROVEEDORES_IA,
} from '../alerts/saldo';
import { humanizeError } from '../humanizeError';

// ─────────────────────────────────────────────────────────────────────────────
// Avisos de saldo de IA (admin). El estado alimenta el globo de Ajustes; el
// canal es el espacio de Chat al que se manda el aviso diario.
// ─────────────────────────────────────────────────────────────────────────────

const router = Router();

router.get('/', async (_req: Request, res: Response): Promise<void> => {
  try {
    const [config, activos] = await Promise.all([getConfigAvisos(), estadosActivos()]);
    res.json({
      config,
      activos: activos.map(e => ({
        proveedor: e.proveedor, nombre: PROVEEDORES_IA[e.proveedor].nombre,
        frena: PROVEEDORES_IA[e.proveedor].frena, consola: PROVEEDORES_IA[e.proveedor].consola,
        desde: e.desde, avisos: e.avisos, ultimo_aviso: e.ultimo_aviso,
        error: humanizeError(e.ultimo_error),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

const ConfigSchema = z.object({
  space_id:   z.string().regex(/^spaces\/[\w-]+$/).nullable(),
  space_name: z.string().max(200).optional(),
});

router.put('/', async (req: Request, res: Response): Promise<void> => {
  const parsed = ConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Espacio de Chat no válido.' });
    return;
  }
  const { space_id, space_name } = parsed.data;
  try {
    await setConfigAvisos(space_id ? { space_id, space_name: space_name || space_id } : null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Para comprobar que el bot está en el espacio ANTES de que haga falta.
router.post('/prueba', async (req: Request, res: Response): Promise<void> => {
  const space = typeof req.body?.space_id === 'string' && req.body.space_id
    ? req.body.space_id : (await getConfigAvisos())?.space_id;
  if (!space) {
    res.status(400).json({ error: 'Elige primero un espacio de Chat.' });
    return;
  }
  try {
    await enviarPrueba(space);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: `No se pudo enviar al espacio: ${humanizeError((e as Error).message)}` });
  }
});

export default router;

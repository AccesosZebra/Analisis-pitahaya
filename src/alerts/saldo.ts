import { dbEnabled, dbLoadAll, dbGet, dbUpsert, dbDelete, AVISOS_TABLE } from '../config/db';

// ─────────────────────────────────────────────────────────────────────────────
// Avisos de saldo de los proveedores de IA.
//
// Sin saldo en Gemini se para la transcripción; en OpenAI, el análisis; en
// Anthropic, los reportes. Y el error que se veía culpaba a la cuenta de
// servicio de Google (un 403 de Gemini caía en el patrón de Drive), así que
// nadie iba a mirar la facturación. Aquí se detecta, se avisa a un espacio de
// Chat UNA vez al día mientras dure (aviso el primero, recordatorio los
// siguientes) y se cierra solo con la primera llamada que vuelva a funcionar.
// ─────────────────────────────────────────────────────────────────────────────

export type Proveedor = 'gemini' | 'openai' | 'anthropic';

export const PROVEEDORES_IA: Record<Proveedor, { nombre: string; frena: string; consola: string }> = {
  gemini:    { nombre: 'Gemini',    frena: 'la transcripción de llamadas está detenida', consola: 'aistudio.google.com → Billing' },
  openai:    { nombre: 'OpenAI',    frena: 'el análisis de llamadas está detenido',      consola: 'platform.openai.com → Billing' },
  anthropic: { nombre: 'Anthropic', frena: 'los reportes y el Radar están detenidos',    consola: 'console.anthropic.com → Plans & Billing' },
};

/**
 * ¿Este error significa que el proveedor se quedó sin saldo (o con la
 * facturación bloqueada)? Pura, para probarla sin red.
 *
 * Lo difícil es no confundirlo con un límite por minuto, que se cura solo:
 * - Gemini dice RESOURCE_EXHAUSTED en los dos casos; lo que delata la falta de
 *   saldo es caer al nivel gratuito (`free_tier`) o el límite diario. Un 403 /
 *   PERMISSION_DENIED de Gemini es facturación o acceso bloqueado.
 * - OpenAI: `insufficient_quota` / "exceeded your current quota" es saldo; el
 *   límite por minuto dice "Rate limit reached".
 * - Anthropic: "credit balance is too low".
 */
export function sinSaldo(raw: string): Proveedor | null {
  const s = raw || '';
  if (/credit balance is too low/i.test(s)) return 'anthropic';
  if (/gemini|generativelanguage/i.test(s)) {
    // Sin "billing": el 429 POR MINUTO también dice "check your plan and billing".
    if (/free_tier|per.?day|\b403\b|PERMISSION_DENIED/i.test(s)) return 'gemini';
    return null;
  }
  if (/openai/i.test(s) && /insufficient_quota|exceeded your current quota/i.test(s)) return 'openai';
  return null;
}

export interface EstadoSaldo {
  proveedor:    Proveedor;
  desde:        string;          // ISO: primer fallo de esta racha
  ultimo_fallo: string;
  ultimo_error: string;          // crudo y recortado, para quien depura
  avisos:       number;          // mensajes ya enviados (0 = aún ninguno)
  ultimo_aviso: string | null;
}

const DIA_MS = 24 * 60 * 60 * 1000;

/** Una vez al día: el primero en cuanto se detecta, luego cada 24 h. */
export function tocaAvisar(e: EstadoSaldo, ahora = new Date()): boolean {
  return !e.ultimo_aviso || ahora.getTime() - new Date(e.ultimo_aviso).getTime() >= DIA_MS;
}

const fecha = (iso: string) => new Date(iso).toLocaleString('es-MX', {
  timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});

export function textoAviso(e: EstadoSaldo, ahora = new Date()): string {
  const p = PROVEEDORES_IA[e.proveedor];
  const dias = Math.floor((ahora.getTime() - new Date(e.desde).getTime()) / DIA_MS);
  const cabeza = e.avisos === 0
    ? `⚠️ *Aviso: ${p.nombre} se quedó sin saldo*`
    : `🔁 *Recordatorio: ${p.nombre} sigue sin saldo* (${dias === 1 ? '1 día' : `${dias} días`})`;
  return [
    cabeza,
    `Desde el ${fecha(e.desde)}, ${p.frena}.`,
    `Recarga en ${p.consola}. En cuanto vuelva a funcionar se reanuda solo y este aviso se cierra.`,
  ].join('\n');
}

// ── Estado ───────────────────────────────────────────────────────────────────
// En memoria, respaldado en la base: los éxitos (cientos al día) consultan el
// Map y solo tocan la base cuando cierran una racha.

const _activos = new Map<Proveedor, EstadoSaldo>();
const _enviando = new Set<Proveedor>();
let _carga: Promise<void> | null = null;

export interface ConfigAvisos { space_id: string; space_name: string }
const CONFIG_ID = 'config';

function cargar(): Promise<void> {
  _carga ??= (async () => {
    if (!dbEnabled) return;
    for (const row of await dbLoadAll<EstadoSaldo & { proveedor?: Proveedor }>(AVISOS_TABLE)) {
      if (row.proveedor && row.proveedor in PROVEEDORES_IA) _activos.set(row.proveedor, row);
    }
  })().catch(e => { _carga = null; throw e; });
  return _carga;
}

async function guardar(e: EstadoSaldo): Promise<void> {
  if (dbEnabled) await dbUpsert(AVISOS_TABLE, e.proveedor, e);
}

export async function getConfigAvisos(): Promise<ConfigAvisos | null> {
  if (!dbEnabled) return null;
  return (await dbGet<ConfigAvisos>(AVISOS_TABLE, CONFIG_ID)) ?? null;
}

export async function setConfigAvisos(cfg: ConfigAvisos | null): Promise<void> {
  if (!dbEnabled) throw new Error('Los avisos necesitan DATABASE_URL.');
  if (cfg) await dbUpsert(AVISOS_TABLE, CONFIG_ID, cfg);
  else await dbDelete(AVISOS_TABLE, CONFIG_ID);
}

export async function estadosActivos(): Promise<EstadoSaldo[]> {
  await cargar();
  return [..._activos.values()];
}

/** Mandar por Chat. Import diferido: google/chat valida el entorno al cargarse. */
async function enviar(spaceId: string, texto: string): Promise<void> {
  const { sendChatMessage } = await import('../google/chat');
  await sendChatMessage(spaceId, texto);
}

export async function enviarPrueba(spaceId: string): Promise<void> {
  await enviar(spaceId,
    '✅ *Prueba de avisos de Zebra Reports*\nAquí llegarán los avisos cuando Gemini, OpenAI o Anthropic se queden sin saldo.');
}

async function avisarSiToca(e: EstadoSaldo): Promise<void> {
  if (!tocaAvisar(e) || _enviando.has(e.proveedor)) return;
  _enviando.add(e.proveedor);   // el barrido falla varias llamadas a la vez: un solo mensaje
  try {
    const cfg = await getConfigAvisos();
    if (!cfg?.space_id) return;   // sin canal se ve igual el globo de Ajustes
    await enviar(cfg.space_id, textoAviso(e));
    e.avisos += 1;
    e.ultimo_aviso = new Date().toISOString();
    await guardar(e);
  } catch (err) {
    console.warn(`[avisos] no se pudo avisar de ${e.proveedor}:`, (err as Error).message);
  } finally {
    _enviando.delete(e.proveedor);
  }
}

/** Llamar con el error CRUDO de cualquier llamada a un proveedor. Nunca lanza. */
export async function registrarFallo(raw: string): Promise<void> {
  const p = sinSaldo(raw);
  if (!p) return;
  try {
    await cargar();
    const ahora = new Date().toISOString();
    const e = _activos.get(p)
      ?? { proveedor: p, desde: ahora, ultimo_fallo: ahora, ultimo_error: '', avisos: 0, ultimo_aviso: null };
    if (!_activos.has(p)) console.warn(`[avisos] ${PROVEEDORES_IA[p].nombre} sin saldo desde ${ahora}`);
    e.ultimo_fallo = ahora;
    e.ultimo_error = raw.slice(0, 500);
    _activos.set(p, e);
    await guardar(e);
    await avisarSiToca(e);
  } catch (err) {
    console.warn('[avisos] registrarFallo:', (err as Error).message);
  }
}

/** Llamar tras cada respuesta buena del proveedor: cierra la racha si la había. */
export async function registrarExito(p: Proveedor): Promise<void> {
  try {
    await cargar();
    if (!_activos.delete(p)) return;
    if (dbEnabled) await dbDelete(AVISOS_TABLE, p);
    console.log(`[avisos] ${PROVEEDORES_IA[p].nombre} vuelve a funcionar: aviso cerrado`);
  } catch (err) {
    console.warn('[avisos] registrarExito:', (err as Error).message);
  }
}

/**
 * Recordatorios aunque no entren llamadas (un fin de semana sin tráfico no
 * debería silenciar el aviso), y el primer aviso de una racha que empezó antes
 * de configurar el canal. Cada hora basta: el umbral es de un día.
 */
export function iniciarAvisos(): void {
  const revisar = async () => {
    try { for (const e of await estadosActivos()) await avisarSiToca(e); }
    catch (err) { console.warn('[avisos] revisión:', (err as Error).message); }
  };
  void revisar();
  setInterval(revisar, 60 * 60 * 1000).unref();
}

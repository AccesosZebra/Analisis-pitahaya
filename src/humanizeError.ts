import { sinSaldo, PROVEEDORES_IA } from './alerts/saldo';

// Traduce el error crudo de un servicio externo al idioma del usuario que lee
// la notificación de Chat o la tarjeta de la automatización. El crudo sigue
// entero en los logs del servidor: aquí solo se decide qué se le enseña a quien
// no sabe qué es un `invalid_request_error`.

// Quién falló. Los mismos códigos (429, 401) llegan de tres proveedores
// distintos —Anthropic escribe los reportes, Gemini transcribe y OpenAI
// clasifica— y el mensaje decía "Anthropic" siempre: un 429 de OpenAI mandaba a
// revisar una API key que no tenía nada que ver. El crudo trae el nombre porque
// lo ponen transcribe.ts y analyze.ts al lanzar el error.
const PROVEEDORES: [RegExp, string, string][] = [
  [/gemini|generativelanguage/i, 'Gemini', 'GEMINI_API_KEY'],
  [/openai/i,                    'OpenAI', 'OPENAI_API_KEY'],
];
const NOMBRE = (raw: string) => PROVEEDORES.find(([re]) => re.test(raw))?.[1] ?? 'Anthropic';
const ENVVAR = (raw: string) => PROVEEDORES.find(([re]) => re.test(raw))?.[2] ?? 'ANTHROPIC_API_KEY';

// Firma cruda → qué pasó y qué hacer. El orden importa: la primera que casa gana,
// así que lo específico (saldo agotado, que llega como 400) va antes que lo genérico.
// `{p}` y `{env}` se sustituyen por el proveedor que de verdad falló.
const PATTERNS: [RegExp, string][] = [
  [/credit balance is too low/i,
   'Se agotaron los créditos de la API de Anthropic. Recarga saldo en console.anthropic.com → Plans & Billing y vuelve a ejecutar.'],
  [/insufficient_quota|RESOURCE_EXHAUSTED/i,
   'Se agotó la cuota de la API de {p}. Recarga saldo en la consola del proveedor y vuelve a ejecutar.'],
  [/rate_limit_error|\b429\b/,
   'La API de {p} limitó las peticiones por volumen. Suele resolverse solo: se reintenta en unos minutos.'],
  [/overloaded_error|\b529\b|\b503\b/,
   'La API de {p} está saturada en este momento. Se reintenta en unos minutos.'],
  [/authentication_error|invalid x-api-key|API key not valid|\b401\b/,
   'La API key de {p} no es válida o fue revocada. Revisa la variable {env} del servidor.'],
  [/permission_denied|caller does not have permission|insufficientPermissions|\b403\b/i,
   'La cuenta de servicio de Google no tiene acceso al Sheet o a la carpeta de Drive del cliente. Compártelos con ella como Editor.'],
  [/Requested entity was not found|\bnotFound\b|\b404\b/,
   'Google no encontró el Sheet o la carpeta configurada. Revisa los IDs en la ficha del cliente.'],
  [/ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up|fetch failed|network error/i,
   'Falló la conexión con un servicio externo (Google, Gemini, OpenAI o Anthropic). Casi siempre es temporal: se reintenta solo.'],
  [/Timeout|timed out/i,
   'La operación tardó más de lo permitido y se canceló. Vuelve a ejecutar; si se repite, reduce el periodo analizado.'],
];

// Un solo error. Si no hay patrón, al menos se le quita el envoltorio JSON del
// SDK, que es el 90% del ruido que asusta al leerlo.
// Un 403 o un 404 de un proveedor de IA no tiene nada que ver con Drive: antes
// caían en los patrones de Google y el aviso mandaba a compartir carpetas con la
// cuenta de servicio mientras Gemini se había quedado sin saldo.
const DE_IA = /gemini|generativelanguage|openai|anthropic|permission_error|not_found_error/i;

function one(raw: string): string {
  // Anthropic conserva su patrón de abajo: un reporte que falló NO se reanuda
  // solo, hay que volver a ejecutarlo, y su mensaje ya lo dice.
  const sin = sinSaldo(raw);
  if (sin && sin !== 'anthropic') {
    const p = PROVEEDORES_IA[sin];
    return `La API de ${p.nombre} se quedó sin saldo o tiene la facturación bloqueada, así que ${p.frena}. `
         + `Recarga en ${p.consola}: lo pendiente se reanuda solo.`;
  }
  if (DE_IA.test(raw) && /PERMISSION_DENIED|permission_error|\b403\b/i.test(raw)) {
    return `La API de ${NOMBRE(raw)} rechazó la petición por permisos. Revisa en su consola que la API key esté activa y con facturación, o la variable ${ENVVAR(raw)}.`;
  }
  if (DE_IA.test(raw) && /not_found_error|NOT_FOUND|\b404\b/i.test(raw)) {
    return `La API de ${NOMBRE(raw)} no encontró el modelo pedido. Puede que lo hayan retirado: hay que actualizar el nombre del modelo en el código.`;
  }
  for (const [re, msg] of PATTERNS) {
    if (re.test(raw)) return msg.replace('{p}', NOMBRE(raw)).replace('{env}', ENVVAR(raw));
  }
  return raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? raw.trim();
}

// Los fallos por asesor llegan concatenados ("Ana: <error> | Melisa: <error>").
// Repetir el mismo error N veces es lo que vuelve ilegible el aviso: se agrupa
// por causa y se nombra a los asesores una sola vez.
function collapse(prefix: string, body: string, sep: string): string {
  const byCause = new Map<string, string[]>();
  for (const part of body.split(sep)) {
    const [, name, err] = part.trim().match(/^([^:]+):\s*([\s\S]+)$/) ?? [];
    if (!name) continue;
    const cause = one(err);
    byCause.set(cause, [...(byCause.get(cause) ?? []), name.trim()]);
  }
  if (byCause.size === 0) return one(body);

  if (byCause.size === 1) {
    const [cause, names] = [...byCause][0];
    return `${cause}\n${prefix} (${names.join(', ')}).`;
  }
  return `${prefix}:\n` +
    [...byCause].map(([cause, names]) => `• ${names.join(', ')}: ${cause}`).join('\n');
}

/**
 * Un fallo que se arregla solo con esperar: cuota, saturación del proveedor o
 * red. No dice nada de la llamada que lo provocó, así que no debe gastar uno de
 * sus intentos: si lo gasta, un pico de 429 congela la llamada para siempre.
 *
 * ponytail: una cuota agotada de verdad reintentará cada minuto sin avanzar. Si
 * eso llega a pesar, cortar por `insufficient_quota` con un backoff por cuenta.
 */
// Sin saldo tampoco es culpa de la llamada: si gastara intentos, al recargar
// quedarían congeladas todas las que fallaron mientras tanto.
export const esTransitorio = (raw: string): boolean =>
  /rate_limit_error|overloaded_error|\b(429|502|503|504|529)\b|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed/i
    .test(raw || '') || sinSaldo(raw || '') !== null;

export function humanizeError(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return 'Error desconocido';

  const all = s.match(/^Todos los asesores fallaron\.\s*([\s\S]+)$/);
  if (all) return collapse('Ningún asesor pudo analizarse', all[1], ' | ');

  const partial = s.match(/^Fallos parciales:\s*([\s\S]+)$/);
  if (partial) return collapse('Algunos asesores no se pudieron analizar', partial[1], ';');

  return one(s);
}

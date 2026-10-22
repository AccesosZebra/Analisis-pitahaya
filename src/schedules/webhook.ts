import { PDFDocument, StandardFonts } from 'pdf-lib';
import { assertHostAllowed } from '../calls/tenant';

// ─────────────────────────────────────────────────────────────────────────────
// Entrega por webhook (n8n) de lo que una automatización generó para un cliente
// externo: su PDF vive en su propia base y no tiene link de Drive que mandar,
// así que el archivo va dentro del POST.
//
// multipart y no JSON con base64: el nodo Webhook de n8n convierte el campo de
// archivo en binario listo para reenviar, y los demás campos llegan en
// $json.body tal cual. Campos planos (sin objetos anidados) por la misma razón.
// ─────────────────────────────────────────────────────────────────────────────

export interface WebhookCampos {
  evento:           'reporte_listo' | 'mensaje';
  cliente_id:       string;
  cliente:          string;
  automatizacion_id: string;
  automatizacion:   string;
  tipo:             string;
  periodicidad:     string;
  periodo:          string;
  mensaje:          string;
}

/** La URL la escribe una persona: solo https y nunca hacia la red interna (anti-SSRF). */
export async function assertWebhookUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new Error('El webhook tiene que ser https.');
  await assertHostAllowed(u.hostname);
  return u;
}

export function webhookForm(campos: WebhookCampos, pdf?: { buf: Buffer; filename: string }): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(campos)) form.append(k, v);
  // Una automatización de tipo Mensaje no genera PDF: va solo el texto.
  if (pdf) form.append('archivo', new Blob([pdf.buf], { type: 'application/pdf' }), pdf.filename);
  return form;
}

/** Hoja de prueba para un Mensaje: deja montar en n8n el manejo del archivo sin generar un reporte. */
export async function pdfDePrueba(): Promise<{ buf: Buffer; filename: string }> {
  const doc  = await PDFDocument.create();
  const page = doc.addPage();
  page.drawText('PDF de prueba - Zebra Reports', { x: 50, y: page.getHeight() - 60, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  return { buf: Buffer.from(await doc.save()), filename: 'prueba.pdf' };
}

/** Lanza si no se pudo entregar; quien llama decide cómo avisarlo. */
export async function enviarWebhook(
  url: string, campos: WebhookCampos, pdf?: { buf: Buffer; filename: string },
): Promise<void> {
  const destino = await assertWebhookUrl(url);
  const res = await fetch(destino, {
    method: 'POST',
    body: webhookForm(campos, pdf),
    redirect: 'error',                    // un 30x podría llevar a la red interna sin pasar por el filtro
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`el webhook respondió ${res.status}`);
}

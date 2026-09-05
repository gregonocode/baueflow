import "server-only";

export type MediaType = "video" | "document";
type Recipient = { instance: string; number: string };
export type SendMediaInput = Recipient & {
  mediaUrl: string;
  mediaType: MediaType;
  fileName?: string;
  caption?: string;
};
export type EvolutionSendResult = { messageId: string | null };

const SEND_TIMEOUT_MS = 20_000;

function redactResponse(response: string) {
  let sanitized = response;
  for (const secret of [process.env.EVOLUTION_API_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY]) {
    if (secret) {
      sanitized = sanitized.split(secret).join("[REDACTED]");
      sanitized = sanitized.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
    }
  }
  return sanitized.slice(0, 2_000);
}

async function send(endpoint: "sendText" | "sendMedia" | "sendButtons", instance: string, body: Record<string, unknown>): Promise<EvolutionSendResult> {
  const baseUrl = process.env.EVOLUTION_API_URL;
  const apiKey = process.env.EVOLUTION_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("Evolution API não configurada.");
  if (!instance.trim()) throw new Error("Instância Evolution não informada.");
  if (typeof body.number !== "string" || !/^\d{8,15}$/.test(body.number)) {
    throw new Error("Telefone inválido para envio.");
  }

  // Payloads verificados no DTO e schema da tag 2.3.7:
  // https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/dto/sendMessage.dto.ts
  let response: Response;
  let responseText: string;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/message/${endpoint}/${encodeURIComponent(instance)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      redirect: "error",
      cache: "no-store",
    });
    responseText = await response.text();
  } catch {
    // Não propagar o objeto de fetch: pode conter URL e credenciais.
    console.error("[Evolution Send] Falha de rede ou timeout", { endpoint });
    throw new Error("Falha de rede ou timeout no envio Evolution.");
  }

  if (!response.ok) {
    console.error("[Evolution Send] Envio recusado", {
      endpoint,
      status: response.status,
      response: redactResponse(responseText),
    });
    throw new Error(`Evolution retornou HTTP ${response.status}.`);
  }

  let payload: { key?: { id?: unknown } };
  try {
    payload = JSON.parse(responseText);
  } catch {
    console.warn("[Evolution Send] Resposta de sucesso sem JSON", { endpoint, status: response.status });
    return { messageId: null };
  }
  return { messageId: typeof payload?.key?.id === "string" ? payload.key.id : null };
}

export async function sendText({ instance, number, text }: Recipient & { text: string }) {
  if (!text.trim()) throw new Error("Texto vazio para envio.");
  return send("sendText", instance, { number, text });
}

export async function sendCopyButton({ instance, number, title, text, copyCode, buttonText = "Copiar Pix" }: Recipient & {
  title: string;
  text: string;
  copyCode: string;
  buttonText?: string;
}) {
  if (!title.trim() || !copyCode.trim() || !buttonText.trim()) throw new Error("Botão de cópia sem título, conteúdo ou texto.");
  // No Baileys da tag 2.3.7, copy é convertido em cta_copy com copy_code.
  return send("sendButtons", instance, {
    number,
    title,
    description: text,
    buttons: [{ type: "copy", displayText: buttonText, copyCode }],
  });
}

export async function sendMedia({ instance, number, mediaUrl, mediaType, fileName, caption }: SendMediaInput) {
  const url = new URL(mediaUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("URL de mídia inválida.");
  }
  if (mediaType !== "video" && mediaType !== "document") throw new Error("Tipo de mídia não suportado.");
  return send("sendMedia", instance, {
    number,
    mediatype: mediaType,
    media: mediaUrl,
    ...(fileName ? { fileName } : {}),
    ...(caption ? { caption } : {}),
  });
}

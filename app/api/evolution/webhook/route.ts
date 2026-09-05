import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { executarAutomacao } from "@/lib/automacoes/executor";
import { acquireConversationLock, ConversationBusyError, releaseConversationLock } from "@/lib/automacoes/lock";

export const runtime = "nodejs";

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}
function text(value: unknown) { return typeof value === "string" ? value : ""; }
function normalizeMessage(value: string) { return value.trim().toLocaleLowerCase("pt-BR"); }

function extractText(value: unknown) {
  let message = object(value);
  for (let depth = 0; depth < 3; depth++) {
    const wrapped = object(message.ephemeralMessage ?? message.viewOnceMessage ?? message.viewOnceMessageV2).message;
    if (!wrapped) break;
    message = object(wrapped);
  }
  return [
    message.conversation,
    object(message.extendedTextMessage).text,
    object(message.imageMessage).caption,
    object(message.videoMessage).caption,
    object(message.buttonsResponseMessage).selectedButtonId,
    object(object(message.listResponseMessage).singleSelectReply).selectedRowId,
    object(message.templateButtonReplyMessage).selectedId,
  ].map(text).find(value => value.trim())?.trim() ?? "";
}

function getPhone(key: JsonObject) {
  const remoteJid = text(key.remoteJid);
  if (remoteJid.endsWith("@g.us") || remoteJid.includes("@broadcast")) return null;
  // @lid é um identificador, não um telefone. Escolher somente o JID telefônico.
  for (const jid of [text(key.remoteJidAlt), remoteJid]) {
    const match = /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid);
    if (match) return match[1];
  }
  return null;
}

export async function POST(request: Request) {
  const expectedSecret = process.env.EVOLUTION_WEBHOOK_SECRET;
  if (!expectedSecret || request.headers.get("x-baueflow-secret") !== expectedSecret) {
    return Response.json({ ok: false }, { status: 401 });
  }
  let rawBody: unknown;
  try { rawBody = await request.json(); }
  catch { return Response.json({ ok: false, reason: "invalid-json" }, { status: 400 }); }
  const body = object(rawBody);
  if (typeof body.event !== "string") return Response.json({ ok: false, reason: "invalid-event" }, { status: 400 });
  const event = body.event.toLowerCase().replace(/_/g, ".");
  if (event !== "messages.upsert") return Response.json({ ok: true, ignored: true, event });

  const instance = text(body.instance);
  if (!instance) return Response.json({ ok: false, reason: "missing-instance" }, { status: 400 });
  if (process.env.EVOLUTION_INSTANCE && instance !== process.env.EVOLUTION_INSTANCE) {
    return Response.json({ ok: true, ignored: true });
  }
  const data = object(body.data);
  const key = object(data.key);
  if (key.fromMe === true) return Response.json({ ok: true, ignored: true, reason: "fromMe" });
  if (key.fromMe !== undefined && typeof key.fromMe !== "boolean") {
    return Response.json({ ok: false, reason: "invalid-key" }, { status: 400 });
  }
  const telefone = getPhone(key);
  if (!telefone) return Response.json({ ok: true, ignored: true, reason: "invalid-contact" });
  const mensagem = extractText(data.message);
  if (!mensagem) return Response.json({ ok: true, ignored: true, reason: "no-text" });
  const externalMessageId = text(key.id).trim();
  if (!externalMessageId) return Response.json({ ok: false, reason: "missing-message-id" }, { status: 400 });

  try {
    const db = getSupabaseAdminClient();
    async function isDuplicate() {
      const { data: existing, error } = await db.from("whatsapp_mensagens").select("id")
        .eq("external_message_id", externalMessageId).eq("direcao", "entrada")
        .eq("payload->>instance", instance).limit(1).maybeSingle();
      if (error) throw new Error("Falha consultando deduplicação.");
      return Boolean(existing);
    }
    if (await isDuplicate()) return Response.json({ ok: true, duplicate: true });

    // Resolver o dono pelo cadastro da instância, sem depender de um usuário global.
    const instanceResult = await db.from("whatsapp_instancias").select("user_id")
      .eq("instance_name", instance).maybeSingle();
    if (instanceResult.error) throw new Error("Falha consultando instância.");
    if (!instanceResult.data) return Response.json({ ok: true, ignored: true, reason: "unknown-instance" });
    const ownerUserId = instanceResult.data.user_id;

    async function findConversation() {
      const { data: conversation, error } = await db.from("whatsapp_conversas")
        .select("id,dados").eq("user_id", ownerUserId).eq("telefone", telefone)
        .eq("status", "ativa").eq("dados->>instancia", instance)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error("Falha consultando conversa.");
      return conversation;
    }
    let conversa = await findConversation();
    if (!conversa) {
      const { data: automacoes, error } = await db.from("automacoes")
        .select("id,gatilho,etapa_inicial_id,iniciar_novas_conversas")
        .eq("user_id", ownerUserId).eq("status", "ativa").order("id");
      if (error) throw new Error("Falha consultando automações.");
      const normalizedMessage = normalizeMessage(mensagem);
      const automacao = automacoes?.find(item => text(item.gatilho).trim() && normalizeMessage(text(item.gatilho)) === normalizedMessage)
        ?? automacoes?.find(item => item.iniciar_novas_conversas === true);
      if (!automacao) return Response.json({ ok: true, noAutomation: true });
      if (!automacao.etapa_inicial_id) return Response.json({ ok: true, noInitialStage: true });

      const created = await db.from("whatsapp_conversas").insert({
        user_id: ownerUserId, automacao_id: automacao.id, etapa_atual_id: automacao.etapa_inicial_id,
        telefone, nome_contato: text(data.pushName) || null, status: "ativa",
        dados: { estado: "iniciada", instancia: instance },
        ultima_interacao_em: new Date().toISOString(),
      }).select("id,dados").single();
      if (created.error?.code === "23505") {
        conversa = await findConversation();
      } else if (created.error) {
        throw new Error("Falha criando conversa.");
      } else {
        conversa = created.data;
      }
      if (!conversa) throw new Error("Conversa não encontrada após criação.");
    }

    // Se ocupado, 503 permite reentrega sem consumir uma entrada ainda não executada.
    const token = await acquireConversationLock(db, conversa.id);
    try {
      if (await isDuplicate()) return Response.json({ ok: true, duplicate: true });
      const latest = await db.from("whatsapp_conversas").select("status,dados")
        .eq("id", conversa.id).eq("execucao_token", token).single();
      if (latest.error) throw new Error("Falha confirmando estado da conversa.");
      if (latest.data.status !== "ativa") throw new ConversationBusyError();
      // Usar o estado sob bloqueio: outra entrega pode ter iniciado a conversa
      // depois do INSERT e antes desta requisição adquirir o lease.
      const isNewConversation = object(latest.data.dados).estado === "iniciada";

      const updated = await db.from("whatsapp_conversas").update({
        ultima_interacao_em: new Date().toISOString(),
        ...(text(data.pushName) ? { nome_contato: text(data.pushName) } : {}),
      }).eq("id", conversa.id).eq("execucao_token", token);
      if (updated.error) throw new Error("Falha atualizando contato.");

      const saved = await db.from("whatsapp_mensagens").insert({
        conversa_id: conversa.id, external_message_id: externalMessageId,
        direcao: "entrada", tipo: text(data.messageType) || "texto", texto: mensagem,
        // O envelope da Evolution pode conter apikey; persistir só os dados da mensagem.
        payload: { event, instance, data }, status: "recebida",
      });
      if (saved.error?.code === "23505" && await isDuplicate()) return Response.json({ ok: true, duplicate: true });
      if (saved.error) throw new Error("Falha registrando entrada.");

      await executarAutomacao({ conversaId: conversa.id, mensagemRecebida: mensagem, isNewConversation, executionToken: token });
      return Response.json({ ok: true });
    } finally {
      await releaseConversationLock(db, conversa.id, token);
    }
  } catch (error) {
    if (error instanceof ConversationBusyError) {
      return Response.json({ ok: false, reason: "conversation-busy" }, { status: 503, headers: { "Retry-After": "3" } });
    }
    console.error("[Evolution Webhook] Falha processando mensagem", { externalMessageId, instance });
    return Response.json({ ok: false }, { status: 500 });
  }
}

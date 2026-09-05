import { getSupabaseAdminClient } from "@/lib/supabase/admin";

import { executarAutomacao } from "@/lib/automacoes/executor";

import {
  acquireConversationLock,
  ConversationBusyError,
  releaseConversationLock,
} from "@/lib/automacoes/lock";

export const runtime = "nodejs";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function normalizeMessage(value: string) {
  return value.trim().toLocaleLowerCase("pt-BR");
}

function maskPhone(phone: string) {
  if (phone.length <= 4) return phone;

  return `${phone.slice(0, 4)}***${phone.slice(-4)}`;
}

function messagePreview(message: string) {
  if (message.length <= 80) return message;

  return `${message.slice(0, 80)}...`;
}

function extractText(value: unknown) {
  let message = object(value);

  for (let depth = 0; depth < 3; depth++) {
    const wrapped = object(
      message.ephemeralMessage ??
        message.viewOnceMessage ??
        message.viewOnceMessageV2
    ).message;

    if (!wrapped) break;

    message = object(wrapped);
  }

  return [
    message.conversation,
    object(message.extendedTextMessage).text,
    object(message.imageMessage).caption,
    object(message.videoMessage).caption,
    object(message.buttonsResponseMessage).selectedButtonId,
    object(object(message.listResponseMessage).singleSelectReply)
      .selectedRowId,
    object(message.templateButtonReplyMessage).selectedId,
  ]
    .map(text)
    .find((value) => value.trim())
    ?.trim() ?? "";
}

function getPhone(key: JsonObject) {
  const remoteJid = text(key.remoteJid);

  if (
    remoteJid.endsWith("@g.us") ||
    remoteJid.includes("@broadcast")
  ) {
    return null;
  }

  // @lid é identificador interno, não telefone.
  for (const jid of [
    text(key.remoteJidAlt),
    remoteJid,
  ]) {
    const match =
      /^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(
        jid
      );

    if (match) {
      return match[1];
    }
  }

  return null;
}

export async function POST(request: Request) {
  console.log(
    "\n========== [Evolution Webhook] NOVA REQUISIÇÃO =========="
  );

  // ======================================================
  // SECRET
  // ======================================================

  const expectedSecret =
    process.env.EVOLUTION_WEBHOOK_SECRET;

  const url = new URL(request.url);

  const receivedSecret =
    request.headers.get("x-baueflow-secret") ||
    url.searchParams.get("secret");

  if (
    !expectedSecret ||
    receivedSecret !== expectedSecret
  ) {
    console.warn(
      "[Evolution Webhook] ❌ Secret inválido"
    );

    return Response.json(
      {
        ok: false,
        reason: "invalid-secret",
      },
      {
        status: 401,
      }
    );
  }

  console.log(
    "[Evolution Webhook] ✅ Secret validado"
  );

  // ======================================================
  // JSON
  // ======================================================

  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    console.warn(
      "[Evolution Webhook] ❌ JSON inválido"
    );

    return Response.json(
      {
        ok: false,
        reason: "invalid-json",
      },
      {
        status: 400,
      }
    );
  }

  const body = object(rawBody);

  if (typeof body.event !== "string") {
    console.warn(
      "[Evolution Webhook] ❌ Evento ausente/inválido",
      {
        receivedEvent: body.event,
      }
    );

    return Response.json(
      {
        ok: false,
        reason: "invalid-event",
      },
      {
        status: 400,
      }
    );
  }

  const event = body.event
    .toLowerCase()
    .replace(/_/g, ".");

  console.log(
    "[Evolution Webhook] Evento recebido:",
    event
  );

  if (event !== "messages.upsert") {
    console.log(
      "[Evolution Webhook] ⏭ Evento ignorado:",
      event
    );

    return Response.json({
      ok: true,
      ignored: true,
      event,
    });
  }

  // ======================================================
  // INSTÂNCIA
  // ======================================================

  const instance = text(body.instance);

  console.log(
    "[Evolution Webhook] Instância recebida:",
    instance || "(vazia)"
  );

  if (!instance) {
    console.warn(
      "[Evolution Webhook] ❌ Instância ausente"
    );

    return Response.json(
      {
        ok: false,
        reason: "missing-instance",
      },
      {
        status: 400,
      }
    );
  }

 
  // ======================================================
  // MESSAGE DATA
  // ======================================================

  const data = object(body.data);
  const key = object(data.key);

  console.log(
    "[Evolution Webhook] Dados principais",
    {
      remoteJid: text(key.remoteJid),
      remoteJidAlt: text(key.remoteJidAlt),
      fromMe: key.fromMe,
      messageId: text(key.id),
      messageType: text(data.messageType),
      pushName: text(data.pushName),
    }
  );

  // ======================================================
  // FROM ME
  // ======================================================

  if (key.fromMe === true) {
    console.log(
      "[Evolution Webhook] ⏭ Mensagem enviada pela própria instância. Ignorando."
    );

    return Response.json({
      ok: true,
      ignored: true,
      reason: "fromMe",
    });
  }

  if (
    key.fromMe !== undefined &&
    typeof key.fromMe !== "boolean"
  ) {
    console.warn(
      "[Evolution Webhook] ❌ fromMe inválido",
      {
        fromMe: key.fromMe,
      }
    );

    return Response.json(
      {
        ok: false,
        reason: "invalid-key",
      },
      {
        status: 400,
      }
    );
  }

  // ======================================================
  // TELEFONE
  // ======================================================

  const telefone = getPhone(key);

  if (!telefone) {
    console.warn(
      "[Evolution Webhook] ⏭ Não foi possível extrair telefone",
      {
        remoteJid: text(key.remoteJid),
        remoteJidAlt: text(key.remoteJidAlt),
      }
    );

    return Response.json({
      ok: true,
      ignored: true,
      reason: "invalid-contact",
    });
  }

  console.log(
    "[Evolution Webhook] ✅ Telefone:",
    maskPhone(telefone)
  );

  // ======================================================
  // TEXTO
  // ======================================================

  const mensagem = extractText(data.message);

  if (!mensagem) {
    console.log(
      "[Evolution Webhook] ⏭ Mensagem sem texto utilizável",
      {
        messageType: text(data.messageType),
        messageKeys: Object.keys(
          object(data.message)
        ),
      }
    );

    return Response.json({
      ok: true,
      ignored: true,
      reason: "no-text",
    });
  }

  console.log(
    "[Evolution Webhook] ✅ Texto extraído:",
    messagePreview(mensagem)
  );

  // ======================================================
  // MESSAGE ID
  // ======================================================

  const externalMessageId = text(key.id).trim();

  if (!externalMessageId) {
    console.warn(
      "[Evolution Webhook] ❌ Message ID ausente"
    );

    return Response.json(
      {
        ok: false,
        reason: "missing-message-id",
      },
      {
        status: 400,
      }
    );
  }

  console.log(
    "[Evolution Webhook] Message ID:",
    externalMessageId
  );

  // ======================================================
  // PROCESSAMENTO
  // ======================================================

  try {
    console.log(
      "[Evolution Webhook] Inicializando Supabase Admin..."
    );

    const db = getSupabaseAdminClient();

    console.log(
      "[Evolution Webhook] ✅ Supabase Admin inicializado"
    );

    // ====================================================
    // DEDUPLICAÇÃO
    // ====================================================

    async function isDuplicate() {
      const { data: existing, error } =
        await db
          .from("whatsapp_mensagens")
          .select("id")
          .eq(
            "external_message_id",
            externalMessageId
          )
          .eq("direcao", "entrada")
          .eq(
            "payload->>instance",
            instance
          )
          .limit(1)
          .maybeSingle();

      if (error) {
        console.error(
          "[Evolution Webhook] ❌ Erro consultando deduplicação",
          {
            code: error.code,
            message: error.message,
          }
        );

        throw new Error(
          "Falha consultando deduplicação."
        );
      }

      return Boolean(existing);
    }

    console.log(
      "[Evolution Webhook] Verificando duplicação..."
    );

    if (await isDuplicate()) {
      console.log(
        "[Evolution Webhook] ⏭ Mensagem duplicada. Ignorando."
      );

      return Response.json({
        ok: true,
        duplicate: true,
      });
    }

    console.log(
      "[Evolution Webhook] ✅ Mensagem não duplicada"
    );

    // ====================================================
    // INSTÂNCIA → USER
    // ====================================================

    console.log(
      "[Evolution Webhook] Procurando instância em whatsapp_instancias...",
      {
        instance,
      }
    );

    const instanceResult =
      await db
        .from("whatsapp_instancias")
        .select("user_id")
        .eq("instance_name", instance)
        .maybeSingle();

    if (instanceResult.error) {
      console.error(
        "[Evolution Webhook] ❌ Erro consultando whatsapp_instancias",
        {
          code: instanceResult.error.code,
          message:
            instanceResult.error.message,
        }
      );

      throw new Error(
        "Falha consultando instância."
      );
    }

    if (!instanceResult.data) {
      console.warn(
        "[Evolution Webhook] ⏭ Instância NÃO cadastrada em whatsapp_instancias",
        {
          instance,
        }
      );

      return Response.json({
        ok: true,
        ignored: true,
        reason: "unknown-instance",
      });
    }

    const ownerUserId =
      instanceResult.data.user_id;

    console.log(
      "[Evolution Webhook] ✅ Instância encontrada",
      {
        instance,
        ownerUserId,
      }
    );

    // ====================================================
    // CONVERSA
    // ====================================================

    async function findConversation() {
      const {
        data: conversation,
        error,
      } = await db
        .from("whatsapp_conversas")
        .select("id,dados")
        .eq("user_id", ownerUserId)
        .eq("telefone", telefone)
        .eq("status", "ativa")
        .eq(
          "dados->>instancia",
          instance
        )
        .order("created_at", {
          ascending: false,
        })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.error(
          "[Evolution Webhook] ❌ Erro buscando conversa",
          {
            code: error.code,
            message: error.message,
          }
        );

        throw new Error(
          "Falha consultando conversa."
        );
      }

      return conversation;
    }

    console.log(
      "[Evolution Webhook] Procurando conversa ativa..."
    );

    let conversa = await findConversation();

    if (conversa) {
      console.log(
        "[Evolution Webhook] ✅ Conversa ativa encontrada",
        {
          conversaId: conversa.id,
          estado: object(conversa.dados).estado,
        }
      );
    } else {
      console.log(
        "[Evolution Webhook] Nenhuma conversa ativa. Procurando automação..."
      );

      // ================================================
      // AUTOMAÇÃO
      // ================================================

      const {
        data: automacoes,
        error,
      } = await db
        .from("automacoes")
        .select(
          "id,nome,gatilho,etapa_inicial_id,iniciar_novas_conversas,status"
        )
        .eq("user_id", ownerUserId)
        .eq("status", "ativa")
        .order("id");

      if (error) {
        console.error(
          "[Evolution Webhook] ❌ Erro consultando automações",
          {
            code: error.code,
            message: error.message,
          }
        );

        throw new Error(
          "Falha consultando automações."
        );
      }

      console.log(
        "[Evolution Webhook] Automações ativas encontradas:",
        automacoes?.map((item) => ({
          id: item.id,
          nome: item.nome,
          gatilho: item.gatilho,
          iniciar_novas_conversas:
            item.iniciar_novas_conversas,
          etapa_inicial_id:
            item.etapa_inicial_id,
        })) ?? []
      );

      const normalizedMessage =
        normalizeMessage(mensagem);

      const automacaoGatilho =
        automacoes?.find(
          (item) =>
            text(item.gatilho).trim() &&
            normalizeMessage(
              text(item.gatilho)
            ) === normalizedMessage
        );

      const automacaoPadrao =
        automacoes?.find(
          (item) =>
            item.iniciar_novas_conversas ===
            true
        );

      const automacao =
        automacaoGatilho ??
        automacaoPadrao;

      if (!automacao) {
        console.warn(
          "[Evolution Webhook] ⏭ Nenhuma automação compatível encontrada",
          {
            mensagem:
              messagePreview(mensagem),
            quantidadeAutomações:
              automacoes?.length ?? 0,
          }
        );

        return Response.json({
          ok: true,
          noAutomation: true,
        });
      }

      console.log(
        "[Evolution Webhook] ✅ Automação selecionada",
        {
          id: automacao.id,
          nome: automacao.nome,
          via:
            automacaoGatilho
              ? "gatilho"
              : "iniciar_novas_conversas",
          etapaInicial:
            automacao.etapa_inicial_id,
        }
      );

      if (!automacao.etapa_inicial_id) {
        console.warn(
          "[Evolution Webhook] ⏭ Automação não possui etapa inicial",
          {
            automacaoId: automacao.id,
            nome: automacao.nome,
          }
        );

        return Response.json({
          ok: true,
          noInitialStage: true,
        });
      }

      // ================================================
      // CRIAR CONVERSA
      // ================================================

      console.log(
        "[Evolution Webhook] Criando nova conversa...",
        {
          automacaoId: automacao.id,
          telefone: maskPhone(telefone),
          etapaInicial:
            automacao.etapa_inicial_id,
        }
      );

      const created =
        await db
          .from("whatsapp_conversas")
          .insert({
            user_id: ownerUserId,

            automacao_id:
              automacao.id,

            etapa_atual_id:
              automacao.etapa_inicial_id,

            telefone,

            nome_contato:
              text(data.pushName) || null,

            status: "ativa",

            dados: {
              estado: "iniciada",
              instancia: instance,
            },

            ultima_interacao_em:
              new Date().toISOString(),
          })
          .select("id,dados")
          .single();

      if (created.error?.code === "23505") {
        console.log(
          "[Evolution Webhook] Conversa ativa já criada por outra requisição. Buscando novamente..."
        );

        conversa = await findConversation();
      } else if (created.error) {
        console.error(
          "[Evolution Webhook] ❌ Erro criando conversa",
          {
            code: created.error.code,
            message: created.error.message,
            details: created.error.details,
            hint: created.error.hint,
          }
        );

        throw new Error(
          "Falha criando conversa."
        );
      } else {
        conversa = created.data;

        console.log(
          "[Evolution Webhook] ✅ Nova conversa criada",
          {
            conversaId:
              conversa?.id,
          }
        );
      }

      if (!conversa) {
        console.error(
          "[Evolution Webhook] ❌ Conversa continua inexistente após criação"
        );

        throw new Error(
          "Conversa não encontrada após criação."
        );
      }
    }

    // ====================================================
    // LOCK
    // ====================================================

    console.log(
      "[Evolution Webhook] Tentando adquirir lock da conversa...",
      {
        conversaId: conversa.id,
      }
    );

    const token =
      await acquireConversationLock(
        db,
        conversa.id
      );

    console.log(
      "[Evolution Webhook] ✅ Lock adquirido",
      {
        conversaId: conversa.id,
      }
    );

    try {
      // ================================================
      // DEDUPLICAÇÃO NOVAMENTE
      // ================================================

      if (await isDuplicate()) {
        console.log(
          "[Evolution Webhook] ⏭ Duplicação detectada após lock"
        );

        return Response.json({
          ok: true,
          duplicate: true,
        });
      }

      // ================================================
      // ESTADO ATUAL
      // ================================================

      const latest =
        await db
          .from("whatsapp_conversas")
          .select("status,dados")
          .eq("id", conversa.id)
          .eq(
            "execucao_token",
            token
          )
          .single();

      if (latest.error) {
        console.error(
          "[Evolution Webhook] ❌ Falha lendo conversa após lock",
          {
            code: latest.error.code,
            message:
              latest.error.message,
          }
        );

        throw new Error(
          "Falha confirmando estado da conversa."
        );
      }

      console.log(
        "[Evolution Webhook] Estado da conversa sob lock",
        {
          status:
            latest.data.status,
          estado: object(
            latest.data.dados
          ).estado,
        }
      );

      if (
        latest.data.status !== "ativa"
      ) {
        console.warn(
          "[Evolution Webhook] Conversa não está ativa"
        );

        throw new ConversationBusyError();
      }

      const isNewConversation =
        object(latest.data.dados)
          .estado === "iniciada";

      console.log(
        "[Evolution Webhook] isNewConversation:",
        isNewConversation
      );

      // ================================================
      // ATUALIZAR CONTATO
      // ================================================

      const updated =
        await db
          .from("whatsapp_conversas")
          .update({
            ultima_interacao_em:
              new Date().toISOString(),

            ...(text(data.pushName)
              ? {
                  nome_contato:
                    text(data.pushName),
                }
              : {}),
          })
          .eq("id", conversa.id)
          .eq(
            "execucao_token",
            token
          );

      if (updated.error) {
        console.error(
          "[Evolution Webhook] ❌ Erro atualizando conversa",
          {
            code:
              updated.error.code,
            message:
              updated.error.message,
          }
        );

        throw new Error(
          "Falha atualizando contato."
        );
      }

      console.log(
        "[Evolution Webhook] ✅ Conversa atualizada"
      );

      // ================================================
      // SALVAR MENSAGEM
      // ================================================

      console.log(
        "[Evolution Webhook] Salvando mensagem recebida..."
      );

      const saved =
        await db
          .from("whatsapp_mensagens")
          .insert({
            conversa_id:
              conversa.id,

            external_message_id:
              externalMessageId,

            direcao: "entrada",

            tipo:
              text(data.messageType) ||
              "texto",

            texto: mensagem,

            payload: {
              event,
              instance,
              data,
            },

            status: "recebida",
          });

      if (
        saved.error?.code ===
          "23505" &&
        (await isDuplicate())
      ) {
        console.log(
          "[Evolution Webhook] ⏭ Insert detectou duplicação"
        );

        return Response.json({
          ok: true,
          duplicate: true,
        });
      }

      if (saved.error) {
        console.error(
          "[Evolution Webhook] ❌ Erro salvando whatsapp_mensagens",
          {
            code: saved.error.code,
            message:
              saved.error.message,
            details:
              saved.error.details,
            hint: saved.error.hint,
          }
        );

        throw new Error(
          "Falha registrando entrada."
        );
      }

      console.log(
        "[Evolution Webhook] ✅ Mensagem salva no banco"
      );

      // ================================================
      // EXECUTOR
      // ================================================

      console.log(
        "[Evolution Webhook] 🚀 Chamando executarAutomacao",
        {
          conversaId:
            conversa.id,
          isNewConversation,
        }
      );

      await executarAutomacao({
        conversaId: conversa.id,
        mensagemRecebida:
          mensagem,
        isNewConversation,
        executionToken: token,
      });

      console.log(
        "[Evolution Webhook] ✅ executarAutomacao finalizado"
      );

      console.log(
        "========== [Evolution Webhook] PROCESSAMENTO CONCLUÍDO ==========\n"
      );

      return Response.json({
        ok: true,
      });
    } finally {
      console.log(
        "[Evolution Webhook] Liberando lock...",
        {
          conversaId:
            conversa.id,
        }
      );

      await releaseConversationLock(
        db,
        conversa.id,
        token
      );

      console.log(
        "[Evolution Webhook] ✅ Lock liberado"
      );
    }
  } catch (error) {
    if (
      error instanceof
      ConversationBusyError
    ) {
      console.warn(
        "[Evolution Webhook] ⚠️ Conversa ocupada"
      );

      return Response.json(
        {
          ok: false,
          reason:
            "conversation-busy",
        },
        {
          status: 503,
          headers: {
            "Retry-After": "3",
          },
        }
      );
    }

    // IMPORTANTE:
    // antes o erro real estava sendo escondido.
    console.error(
      "[Evolution Webhook] ❌ FALHA NO PROCESSAMENTO",
      {
        externalMessageId,
        instance,

        error:
          error instanceof Error
            ? {
                name: error.name,
                message:
                  error.message,
                stack:
                  error.stack,
              }
            : String(error),
      }
    );

    return Response.json(
      {
        ok: false,
        reason:
          "internal-error",
      },
      {
        status: 500,
      }
    );
  }
}
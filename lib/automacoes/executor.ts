import "server-only";
import { setTimeout as sleep } from "node:timers/promises";
import { sendMedia, sendText, type EvolutionSendResult, type MediaType } from "../evolution";
import { getSupabaseAdminClient } from "../supabase/admin";
import { acquireConversationLock, releaseConversationLock, renewConversationLock } from "./lock";

type JsonObject = Record<string, unknown>;
type Conversation = {
  id: string;
  user_id: string;
  automacao_id: string;
  etapa_atual_id: string | null;
  telefone: string;
  nome_contato: string | null;
  email: string | null;
  escolha: string | null;
  status: string;
  dados: JsonObject | null;
};
type Stage = { id: string; nome: string; tipo: string; config: JsonObject | null };
type Option = { id: string; label: string };
type File = { nome: string; tipo: string; public_url: string };
type ExecutionInput = {
  conversaId: string;
  mensagemRecebida?: string;
  isNewConversation?: boolean;
  /** Interno: o webhook adquire o bloqueio ANTES de registrar a entrada. */
  executionToken?: string;
};

const MAX_STEPS = 30;
const API_TIMEOUT_MS = 15_000;
class ExecutorError extends Error {}

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
}
function text(value: unknown) { return typeof value === "string" ? value : ""; }

export function substituirVariaveis(value: string, conversa: Pick<Conversation, "nome_contato" | "telefone" | "email">) {
  const values: Record<string, string> = { nome: conversa.nome_contato ?? "", telefone: conversa.telefone ?? "", email: conversa.email ?? "" };
  return value.replace(/{{\s*(nome|telefone|email)\s*}}/g, (_, key: string) => values[key]);
}

function replaceRecursive(value: unknown, conversa: Conversation): unknown {
  if (typeof value === "string") return substituirVariaveis(value, conversa);
  if (Array.isArray(value)) return value.map(item => replaceRecursive(item, conversa));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceRecursive(item, conversa)]));
  }
  return value;
}

function optionsOf(config: JsonObject): Option[] {
  if (!Array.isArray(config.opcoes) || !config.opcoes.length) throw new ExecutorError("Etapa sem opções configuradas.");
  const options = config.opcoes.map(item => {
    const option = object(item);
    if (!text(option.id).trim() || !text(option.label).trim()) throw new ExecutorError("Opção sem ID ou texto.");
    return { id: text(option.id), label: text(option.label) };
  });
  if (new Set(options.map(option => option.id)).size !== options.length) throw new ExecutorError("IDs de opções repetidos.");
  return options;
}

function matchOption(answer: string, options: Option[], conversa: Conversation) {
  const value = answer.trim();
  // Número primeiro; depois ID exato; depois label completo sem distinguir caixa.
  if (/^[1-9]\d*$/.test(value) && Number(value) <= options.length) return options[Number(value) - 1];
  return options.find(option => option.id === value)
    ?? options.find(option => substituirVariaveis(option.label, conversa).trim().toLocaleLowerCase("pt-BR") === value.toLocaleLowerCase("pt-BR"));
}

async function callActionApi(config: JsonObject, conversa: Conversation) {
  const method = text(config.method || "POST").toUpperCase();
  if (!["POST", "PUT", "PATCH"].includes(method)) throw new ExecutorError("Método da ação API não permitido.");
  let url: URL;
  try { url = new URL(substituirVariaveis(text(config.url), conversa)); }
  catch { throw new ExecutorError("URL da ação API inválida."); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new ExecutorError("URL da ação API inválida.");
  const configuredHeaders = replaceRecursive(config.headers ?? {}, conversa);
  if (!configuredHeaders || typeof configuredHeaders !== "object" || Array.isArray(configuredHeaders)) {
    throw new ExecutorError("Headers da ação API devem ser um objeto.");
  }
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const [key, value] of Object.entries(configuredHeaders)) {
    if (typeof value !== "string") throw new ExecutorError("Valores de headers devem ser texto.");
    headers.set(key, value);
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: JSON.stringify(replaceRecursive(config.body ?? {}, conversa)),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new ExecutorError("Falha de rede ou timeout na ação API.");
  }
  // Não registrar resposta, URL ou headers: APIs podem ecoar credenciais.
  await response.body?.cancel();
  if (!response.ok) throw new ExecutorError(`Ação API retornou HTTP ${response.status}.`);
}

export async function executarAutomacao({ conversaId, mensagemRecebida, isNewConversation = false, executionToken }: ExecutionInput) {
  const db = getSupabaseAdminClient();
  const token = executionToken ?? await acquireConversationLock(db, conversaId);
  let conversa: Conversation | null = null;
  let currentStageId: string | null = null;

  try {
    await renewConversationLock(db, conversaId, token);
    const result = await db.from("whatsapp_conversas")
      .select("id,user_id,automacao_id,etapa_atual_id,telefone,nome_contato,email,escolha,status,dados")
      .eq("id", conversaId).eq("execucao_token", token).maybeSingle();
    if (result.error) throw new ExecutorError("Erro carregando conversa.");
    conversa = result.data as Conversation | null;
    if (!conversa || conversa.status !== "ativa" || !conversa.etapa_atual_id) return;
    conversa.dados = object(conversa.dados);
    if (["erro", "pausada"].includes(text(conversa.dados.estado))) return;

    // Service role ignora RLS: conferir explicitamente o dono da automação.
    const automation = await db.from("automacoes").select("id")
      .eq("id", conversa.automacao_id).eq("user_id", conversa.user_id).maybeSingle();
    if (automation.error || !automation.data) throw new ExecutorError("Automação não pertence ao usuário da conversa.");

    const recordedInstance = text(conversa.dados.instancia);
    let instanceQuery = db.from("whatsapp_instancias").select("instance_name")
      .eq("user_id", conversa.user_id).eq("status", "ativa");
    if (recordedInstance) instanceQuery = instanceQuery.eq("instance_name", recordedInstance);
    // Se houver várias ativas sem instância registrada, a escolha é estável.
    const instanceResult = await instanceQuery.order("instance_name").limit(1).maybeSingle();
    const instance = instanceResult.data?.instance_name;
    if (instanceResult.error || typeof instance !== "string" || !instance) {
      throw new ExecutorError("Instância ativa da conversa não encontrada para este usuário.");
    }

    const activeConversation = conversa;
    async function update(patch: Partial<Conversation>, dataPatch: JsonObject = {}) {
      const dados = { ...activeConversation.dados, ...dataPatch };
      const { data, error } = await db.from("whatsapp_conversas")
        .update({ ...patch, dados }).eq("id", conversaId).eq("user_id", activeConversation.user_id)
        .eq("execucao_token", token).select("id").maybeSingle();
      if (error || !data) throw new ExecutorError("Erro atualizando estado da conversa.");
      Object.assign(activeConversation, patch, { dados });
    }

    async function logSent(result: EvolutionSendResult, tipo: string, texto: string, metadata: JsonObject = {}) {
      const { error } = await db.from("whatsapp_mensagens").insert({
        conversa_id: conversaId,
        external_message_id: result.messageId,
        direcao: "saida", tipo, texto, status: "enviada",
        payload: { etapa_id: currentStageId, instance, ...metadata },
      });
      if (error) throw new ExecutorError("Mensagem enviada, mas houve falha ao registrar a saída. Revisão manual necessária.");
    }

    async function sendMessage(value: string) {
      const rendered = substituirVariaveis(value, activeConversation);
      if (!rendered.trim()) throw new ExecutorError("Texto da etapa vazio.");
      await renewConversationLock(db, conversaId, token);
      const sent = await sendText({ instance, number: activeConversation.telefone, text: rendered });
      await logSent(sent, "texto", rendered);
    }

    async function sendFile(mediaUrl: string, mediaType: MediaType, caption = "", fileName?: string) {
      if (!mediaUrl) throw new ExecutorError("Arquivo sem URL pública.");
      await renewConversationLock(db, conversaId, token);
      const renderedCaption = substituirVariaveis(caption, activeConversation);
      const sent = await sendMedia({ instance, number: activeConversation.telefone, mediaUrl, mediaType, fileName, caption: renderedCaption });
      await logSent(sent, mediaType === "video" ? "video" : "documento", renderedCaption, { mediaUrl, fileName });
    }

    async function pause(reason: string) {
      console.warn("[Automation Executor]", { conversaId, etapaId: currentStageId, reason });
      await update({}, { estado: "pausada", motivo_pausa: reason, etapa_espera_id: null });
    }

    async function advance(stage: Stage, key = "default", patch: Partial<Conversation> = {}) {
      const { data, error } = await db.from("automacao_conexoes").select("destino_etapa_id")
        .eq("automacao_id", activeConversation.automacao_id).eq("origem_etapa_id", stage.id)
        .eq("chave_saida", key).maybeSingle();
      if (error) throw new ExecutorError("Erro buscando conexão da etapa.");
      if (!data?.destino_etapa_id) {
        await pause("Etapa sem conexão de saída configurada.");
        return false;
      }
      // O destino também será validado pelo automacao_id na próxima iteração.
      await update({ ...patch, etapa_atual_id: data.destino_etapa_id }, {
        estado: "executando", etapa_espera_id: null, motivo_pausa: null,
      });
      return true;
    }

    async function sendOptions(stage: Stage) {
      const config = object(stage.config);
      const menu = optionsOf(config).map((option, index) => `${index + 1} - ${option.label}`).join("\n");
      await sendMessage([text(config.texto), menu].filter(Boolean).join("\n\n"));
      await update({}, { estado: "aguardando_opcao", etapa_espera_id: stage.id });
    }

    // Só a etapa que JÁ aguardava no início da chamada pode consumir a resposta.
    // Uma nova pergunta alcançada no loop sempre é enviada e aguarda outro webhook.
    let answer = isNewConversation ? undefined : mensagemRecebida;
    let mayConsumeAnswer = !isNewConversation;
    for (let steps = 0; steps < MAX_STEPS; steps++) {
      await renewConversationLock(db, conversaId, token);
      currentStageId = activeConversation.etapa_atual_id;
      if (!currentStageId) return;
      const stageResult = await db.from("automacao_etapas").select("id,nome,tipo,config")
        .eq("id", currentStageId).eq("automacao_id", activeConversation.automacao_id).maybeSingle();
      if (stageResult.error || !stageResult.data) throw new ExecutorError("Etapa atual não encontrada nesta automação.");
      const stage = stageResult.data as Stage;
      const config = object(stage.config);
      const state = activeConversation.dados?.estado;
      const waiting = state === "aguardando_opcao" || state === "aguardando_email";

      if (mayConsumeAnswer && waiting) {
        if (activeConversation.dados?.etapa_espera_id && activeConversation.dados.etapa_espera_id !== stage.id) {
          throw new ExecutorError("Etapa de espera diferente da etapa atual.");
        }
        if (answer === undefined) return;
        const received = answer.trim();
        answer = undefined;
        mayConsumeAnswer = false;
        if (state === "aguardando_opcao" && stage.tipo === "opcoes") {
          const option = matchOption(received, optionsOf(config), activeConversation);
          if (!option) {
            await sendMessage("Não consegui identificar sua escolha. Responda com uma das opções abaixo:");
            await sendOptions(stage);
            return;
          }
          if (!await advance(stage, option.id, { escolha: option.id })) return;
          continue;
        }
        if (state === "aguardando_email" && stage.tipo === "capturar_email") {
          if (!received || (config.validar !== false && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(received))) {
            await sendMessage(text(config.mensagem_invalida).trim() || "Esse e-mail parece inválido. Pode enviar novamente?");
            return;
          }
          await update({ email: received }, { estado: "executando", etapa_espera_id: null });
          if (!await advance(stage)) return;
          continue;
        }
        throw new ExecutorError("Tipo de etapa incompatível com a resposta aguardada.");
      }

      mayConsumeAnswer = false;
      answer = undefined;
      await update({}, { estado: "executando", etapa_espera_id: null, instancia: instance });
      console.log("[Automation Executor] Executando etapa", { conversaId, etapaId: stage.id, tipo: stage.tipo });

      switch (stage.tipo) {
        case "mensagem":
          await sendMessage(text(config.texto));
          break;
        case "video":
          await sendFile(text(config.url), "video", text(config.caption));
          break;
        case "arquivo": {
          const filesResult = await db.from("automacao_arquivos").select("nome,tipo,public_url")
            .eq("etapa_id", stage.id).eq("automacao_id", activeConversation.automacao_id).order("ordem");
          if (filesResult.error) throw new ExecutorError("Erro carregando arquivos da etapa.");
          const files = filesResult.data as File[] | null;
          if (!files?.length) throw new ExecutorError("Etapa sem arquivos associados.");
          for (const file of files) {
            const mediaType = file.tipo === "video" ? "video" : ["pdf", "documento", "document"].includes(file.tipo) ? "document" : null;
            if (!mediaType) throw new ExecutorError("Tipo de arquivo não suportado.");
            await sendFile(file.public_url, mediaType, text(config.caption), file.nome);
          }
          break;
        }
        case "opcoes":
          await sendOptions(stage);
          return;
        case "capturar_email":
          await sendMessage(text(config.mensagem));
          await update({}, { estado: "aguardando_email", etapa_espera_id: stage.id });
          return;
        case "acao_api":
          await callActionApi(config, activeConversation);
          break;
        case "pix": {
          if (text(config.mensagem).trim()) await sendMessage(text(config.mensagem));
          if (process.env.NODE_ENV !== "production") {
            const cents = Number(config.valor_centavos);
            if (!Number.isSafeInteger(cents) || cents < 0) throw new ExecutorError("Valor Pix inválido.");
            const amount = (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            await sendMessage(`[PIX pendente de integração: R$ ${amount}]`);
          }
          await pause("PIX gateway not configured");
          return;
        }
        case "espera": {
          const seconds = Number(config.segundos);
          if (!Number.isFinite(seconds) || seconds < 0) throw new ExecutorError("Tempo de espera inválido.");
          if (seconds > 10) {
            await pause("Espera longa ainda não implementada.");
            return;
          }
          await sleep(seconds * 1_000);
          break;
        }
        case "fim":
          if (text(config.mensagem).trim()) await sendMessage(text(config.mensagem));
          await update({ status: "finalizada", etapa_atual_id: null }, { estado: "finalizada", etapa_espera_id: null });
          return;
        default:
          throw new ExecutorError("Tipo de etapa não suportado pelo executor.");
      }
      if (!await advance(stage)) return;
    }
    throw new ExecutorError("Limite de 30 etapas por execução atingido; verifique ciclos no fluxo.");
  } catch (error) {
    const reason = error instanceof ExecutorError ? error.message : "Falha no envio ou na execução da etapa.";
    console.error("[Automation Executor] Execução interrompida", { conversaId, etapaId: currentStageId, reason });
    if (conversa) {
      const { error: saveError } = await db.from("whatsapp_conversas").update({
        dados: { ...conversa.dados, estado: "erro", erro: reason, etapa_erro_id: currentStageId, erro_em: new Date().toISOString() },
      }).eq("id", conversaId).eq("execucao_token", token);
      if (saveError) console.error("[Automation Executor] Falha ao persistir estado de erro", { conversaId });
    }
    throw new Error(reason);
  } finally {
    if (!executionToken) await releaseConversationLock(db, conversaId, token);
  }
}

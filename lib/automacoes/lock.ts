import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Lease persistido no banco: funciona entre processos e invocações serverless.
// Renovado antes de cada etapa/envio; cada chamada externa tem timeout de 20 s.
const LEASE_MS = 120_000;

export class ConversationBusyError extends Error {
  constructor() { super("Conversa já está em execução."); }
}

export async function acquireConversationLock(db: SupabaseClient, conversaId: string) {
  const token = randomUUID();
  const { data, error } = await db.from("whatsapp_conversas")
    .update({ execucao_token: token, execucao_ate: new Date(Date.now() + LEASE_MS).toISOString() })
    .eq("id", conversaId)
    .or(`execucao_token.is.null,execucao_ate.lt.${new Date().toISOString()}`)
    .select("id").maybeSingle();
  if (error) throw new Error("Não foi possível bloquear a conversa para execução.");
  if (!data) throw new ConversationBusyError();
  return token;
}

export async function renewConversationLock(db: SupabaseClient, conversaId: string, token: string) {
  const { data, error } = await db.from("whatsapp_conversas")
    .update({ execucao_ate: new Date(Date.now() + LEASE_MS).toISOString() })
    .eq("id", conversaId).eq("execucao_token", token)
    .select("id").maybeSingle();
  if (error || !data) throw new Error("Bloqueio da conversa perdido.");
}

export async function releaseConversationLock(db: SupabaseClient, conversaId: string, token: string) {
  const { error } = await db.from("whatsapp_conversas")
    .update({ execucao_token: null, execucao_ate: null })
    .eq("id", conversaId).eq("execucao_token", token);
  if (error) console.error("[Automation Executor] Falha ao liberar bloqueio", { conversaId });
}

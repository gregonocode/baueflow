import Link from "next/link";
import { Bot, MessageCircleMore, Plus, Users, Zap } from "lucide-react";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { AutomacoesList, type AutomationListItem } from "./automacoes-list";

const defaultDescription = "Automação de atendimento pelo WhatsApp.";

function formatUpdatedAt(value: string | null) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "—";
  const date = new Date(value);
  const now = new Date();
  const datePart = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const timePart = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (datePart.format(date) === datePart.format(now)) return `Hoje, ${timePart.format(date)}`;
  if (datePart.format(date) === datePart.format(yesterday)) return `Ontem, ${timePart.format(date)}`;
  return `${datePart.format(date)}, ${timePart.format(date)}`;
}

export default async function AutomacoesPage() {
  let automacoes: AutomationListItem[] = [];
  let totalConversas = 0;
  let totalContatos = 0;

  try {
    const supabase = await getSupabaseServerClient();
    const { data: auth, error: authError } = supabase ? await supabase.auth.getUser() : { data: { user: null }, error: null };
    if (!supabase || authError || !auth.user) {
      if (authError) console.error("Falha ao obter sessão para a listagem de automações.", authError);
    } else {
      const [automacoesResult, conversasResult] = await Promise.all([
        supabase.from("automacoes").select("id,nome,descricao,gatilho,status,updated_at").eq("user_id", auth.user.id).order("updated_at", { ascending: false }),
        supabase.from("whatsapp_conversas").select("automacao_id,telefone").eq("user_id", auth.user.id),
      ]);

      if (automacoesResult.error) {
        console.error("Falha ao carregar automações.", automacoesResult.error);
      } else {
        const automationIds = new Set(automacoesResult.data.map((automation) => automation.id));
        const metricsByAutomation = new Map<string, { conversas: number; contatos: Set<string> }>();
        const contacts = new Set<string>();
        if (conversasResult.error) {
          console.error("Falha ao carregar conversas das automações.", conversasResult.error);
        } else {
          for (const conversa of conversasResult.data) {
            if (!conversa.automacao_id || !automationIds.has(conversa.automacao_id)) continue;
            const metrics = metricsByAutomation.get(conversa.automacao_id) ?? { conversas: 0, contatos: new Set<string>() };
            metrics.conversas += 1;
            if (conversa.telefone) { metrics.contatos.add(conversa.telefone); contacts.add(conversa.telefone); }
            metricsByAutomation.set(conversa.automacao_id, metrics);
            totalConversas += 1;
          }
          totalContatos = contacts.size;
        }
        automacoes = automacoesResult.data.map((automation) => {
          const metrics = metricsByAutomation.get(automation.id);
          return { id: automation.id, nome: automation.nome, descricao: automation.descricao?.trim() || defaultDescription, gatilho: automation.gatilho, status: automation.status, conversas: metrics?.conversas ?? 0, contatos: metrics?.contatos.size ?? 0, atualizadaEm: formatUpdatedAt(automation.updated_at) };
        });
      }
    }
  } catch (error) {
    console.error("Erro inesperado ao carregar automações.", error);
  }

  const automacoesAtivas = automacoes.filter((automacao) => automacao.status === "ativa").length;
  return <div className="mx-auto w-full max-w-[1400px]"><div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between"><div><div className="mb-2 flex items-center gap-2 text-sm font-medium text-[#3f7655]"><Bot className="size-4" />Automações</div><h1 className="text-2xl font-bold tracking-tight text-[#172033] sm:text-3xl">Suas automações</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[#7c8395]">Crie fluxos automáticos para atender, entregar seus produtos e vender diretamente pelo WhatsApp.</p></div><Link href="/dashboard/automacoes/nova" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#286342] px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#205638]"><Plus className="size-[18px]" />Nova automação</Link></div><div className="mt-8 grid gap-4 sm:grid-cols-3"><StatCard icon={Zap} label="Automações ativas" value={automacoesAtivas} description={`${automacoes.length} automações criadas`} /><StatCard icon={MessageCircleMore} label="Conversas iniciadas" value={totalConversas} description="Total das automações" /><StatCard icon={Users} label="Contatos" value={totalContatos} description="Pessoas nos seus fluxos" /></div><AutomacoesList automacoes={automacoes} /></div>;
}

function StatCard({ icon: Icon, label, value, description }: { icon: React.ElementType; label: string; value: number; description: string }) { return <div className="rounded-2xl border border-[#dfede3] bg-[#fbfefc] p-5 shadow-[0_1px_2px_rgba(23,32,51,0.03)]"><div className="flex items-start justify-between"><div><p className="text-sm font-medium text-[#7b8394]">{label}</p><p className="mt-2 text-3xl font-bold tracking-tight text-[#172033]">{value}</p></div><div className="flex size-10 items-center justify-center rounded-xl bg-[#e2f2e7] text-[#286342]"><Icon className="size-[19px]" /></div></div><p className="mt-3 text-xs text-[#9aa0ae]">{description}</p></div>; }

//app\dashboard\automacoes\[id]\page.tsx
import { notFound } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { AutomationEditor } from "./automation-editor";

export default async function Page({ params }: PageProps<"/dashboard/automacoes/[id]">) {
  const { id } = await params;
  const supabase = await getSupabaseServerClient();
  const { data: { user } } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
  if (!supabase || !user) notFound();
  const { data: automation } = await supabase.from("automacoes").select("id,nome,gatilho,status,etapa_inicial_id,iniciar_novas_conversas").eq("id", id).eq("user_id", user.id).maybeSingle();
  if (!automation) notFound();
  const [stages, connections, files] = await Promise.all([
    supabase.from("automacao_etapas").select("id,nome,tipo,config,position_x,position_y").eq("automacao_id", id).order("position_y"),
    supabase.from("automacao_conexoes").select("id,origem_etapa_id,destino_etapa_id,chave_saida,label,ordem").eq("automacao_id", id).order("ordem"),
    supabase.from("automacao_arquivos").select("id,etapa_id,nome,tipo,public_url").eq("automacao_id", id).order("ordem"),
  ]);
  return <AutomationEditor automation={automation} stages={stages.data ?? []} connections={connections.data ?? []} files={files.data ?? []} />;
}

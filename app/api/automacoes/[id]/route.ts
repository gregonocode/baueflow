import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest, { params }: RouteContext<"/api/automacoes/[id]">) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Serviço indisponível." }, { status: 503 });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  const { id } = await params;
  const { data: automation } = await supabase.from("automacoes").select("id").eq("id", id).eq("user_id", user.id).maybeSingle();
  if (!automation) return NextResponse.json({ error: "Não encontrado." }, { status: 404 });

  const body = await request.json();
  let error: { message: string } | null = null;
  if (body.action === "update-automation") ({ error } = await supabase.from("automacoes").update({ nome: body.nome, gatilho: body.gatilho, status: body.status, iniciar_novas_conversas: Boolean(body.iniciar_novas_conversas) }).eq("id", id).eq("user_id", user.id));
  let createdStage: { id: string } | null = null;
  if (body.action === "create-stage") { const result = await supabase.from("automacao_etapas").insert({ automacao_id: id, nome: body.stage.nome, tipo: body.stage.tipo, config: body.stage.config ?? {}, position_x: 0, position_y: body.stage.position_y }).select("id").single(); error = result.error; createdStage = result.data; }
  if (body.action === "update-stage") ({ error } = await supabase.from("automacao_etapas").update({ nome: body.stage.nome, config: body.stage.config ?? {} }).eq("id", body.stage.id).eq("automacao_id", id));
  if (body.action === "delete-stage") { await supabase.from("automacao_conexoes").delete().eq("automacao_id", id).or(`origem_etapa_id.eq.${body.stageId},destino_etapa_id.eq.${body.stageId}`); await supabase.from("automacao_arquivos").delete().eq("automacao_id", id).eq("etapa_id", body.stageId); ({ error } = await supabase.from("automacao_etapas").delete().eq("id", body.stageId).eq("automacao_id", id)); }
  if (body.action === "move-stages") { for (const stage of body.stages) { const result = await supabase.from("automacao_etapas").update({ position_y: stage.position_y }).eq("id", stage.id).eq("automacao_id", id); if (result.error) { error = result.error; break; } } }
  if (body.action === "set-initial") ({ error } = await supabase.from("automacoes").update({ etapa_inicial_id: body.stageId }).eq("id", id).eq("user_id", user.id));
  if (body.action === "set-connection") { await supabase.from("automacao_conexoes").delete().eq("automacao_id", id).eq("origem_etapa_id", body.origem).eq("chave_saida", body.key); if (body.destino) ({ error } = await supabase.from("automacao_conexoes").insert({ automacao_id: id, origem_etapa_id: body.origem, destino_etapa_id: body.destino, chave_saida: body.key, label: body.label ?? body.key, ordem: body.ordem ?? 0 })); }
  if (!body.action) return NextResponse.json({ error: "Ação inválida." }, { status: 400 });
  if (error) return NextResponse.json({ error: "Não foi possível salvar a alteração." }, { status: 400 });
  return NextResponse.json({ ok: true, stage: createdStage });
}

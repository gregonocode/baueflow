import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) return NextResponse.json({ error: "Serviço indisponível." }, { status: 503 });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
  const { nome, gatilho, status, iniciar_novas_conversas } = await request.json();
  const normalizedName = String(nome ?? "").trim();
  if (!normalizedName) return NextResponse.json({ error: "Nome obrigatório." }, { status: 400 });
  const slugBase = normalizedName.toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "automacao";
  const slug = `${slugBase}-${crypto.randomUUID().slice(0, 8)}`;
  const { data, error } = await supabase.from("automacoes").insert({ user_id: user.id, nome: normalizedName, slug, gatilho: String(gatilho ?? "").trim(), status: status || "rascunho", iniciar_novas_conversas: Boolean(iniciar_novas_conversas), config: {} }).select("id").single();
  if (error) {
    console.error("Falha ao inserir automação no Supabase.", error);
    return NextResponse.json({ error: "Não foi possível criar a automação." }, { status: 400 });
  }
  return NextResponse.json({ id: data.id }, { status: 201 });
}

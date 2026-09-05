import { getSupabaseServerClient } from "@/lib/supabase/server";
import { handleAutomationFiles } from "@/lib/automacoes/files";

async function handle(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const db = await getSupabaseServerClient();
  if (!db) return Response.json({ error: "Serviço indisponível." }, { status: 503 });
  return handleAutomationFiles(request, db, (await params).id);
}

export { handle as GET, handle as POST, handle as DELETE };

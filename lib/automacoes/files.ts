import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_PDF_BYTES, sanitizedPdfName, validatePdf } from "./pdf";

const bucket = "whatsapp-assets";
const columns = "id,etapa_id,nome,tipo,public_url,tamanho_bytes,ordem";
const fail = (error: string, status = 400) => Response.json({ error }, { status });

export async function handleAutomationFiles(request: Request, db: SupabaseClient, automationId: string) {
  try {
    const { data: { user }, error: authError } = await db.auth.getUser();
    if (authError || !user) return fail("Sua sessão expirou. Entre novamente.", 401);
    const stageId = new URL(request.url).searchParams.get("etapa_id");
    if (!stageId) return fail("Informe a etapa.");
    const automation = await db.from("automacoes").select("id").eq("id", automationId).eq("user_id", user.id).maybeSingle();
    if (automation.error) return fail("Não foi possível verificar a automação.", 500);
    if (!automation.data) return fail("Automação não encontrada.", 404);
    const stage = await db.from("automacao_etapas").select("id,tipo").eq("id", stageId).eq("automacao_id", automationId).maybeSingle();
    if (stage.error) return fail("Não foi possível verificar a etapa.", 500);
    if (!stage.data || stage.data.tipo !== "arquivo") return fail("Etapa de arquivos não encontrada.", 404);
    const storage = db.storage.from(bucket);

    if (request.method === "GET") {
      const result = await db.from("automacao_arquivos").select(columns).eq("automacao_id", automationId).eq("etapa_id", stageId).order("ordem");
      if (result.error) return fail("Não foi possível carregar os arquivos.", 500);
      return Response.json({ files: result.data });
    }
    if (request.method === "POST") {
      // O limite real é conferido no File; este rejeita corpos grandes antes de ler o multipart.
      if (Number(request.headers.get("content-length")) > MAX_PDF_BYTES + 1024 * 1024) return fail("Cada PDF deve ter no máximo 20 MB.", 413);
      let form: FormData;
      try { form = await request.formData(); } catch { return fail("Não foi possível ler o PDF enviado."); }
      const file = form.get("file");
      if (!(file instanceof File)) return fail("Selecione um PDF para enviar.");
      const validation = validatePdf(file);
      if (validation) return fail(validation);
      if (await file.slice(0, 5).text() !== "%PDF-") return fail("O arquivo não contém um PDF válido.");
      const last = await db.from("automacao_arquivos").select("ordem").eq("automacao_id", automationId).eq("etapa_id", stageId)
        .order("ordem", { ascending: false }).limit(1).maybeSingle();
      if (last.error) return fail("Não foi possível organizar os arquivos.", 500);
      const path = `${user.id}/${automationId}/${stageId}/${crypto.randomUUID()}-${sanitizedPdfName(file.name)}`;
      const upload = await storage.upload(path, file, { contentType: "application/pdf", upsert: false });
      if (upload.error) return fail("Não foi possível enviar o PDF. Tente novamente.", 500);
      const { data: { publicUrl } } = storage.getPublicUrl(path);
      const result = await db.from("automacao_arquivos").insert({
        automacao_id: automationId, etapa_id: stageId, nome: file.name, tipo: "pdf",
        storage_path: path, public_url: publicUrl, mime_type: "application/pdf",
        tamanho_bytes: file.size, ordem: (last.data?.ordem ?? 0) + 1,
      }).select(columns).single();
      if (result.error) {
        const cleanup = await storage.remove([path]);
        if (cleanup.error) console.error("Falha ao limpar upload de PDF sem registro.", { path });
        return fail("Não foi possível cadastrar o PDF. Tente novamente.", 500);
      }
      return Response.json({ file: result.data }, { status: 201 });
    }
    if (request.method === "DELETE") {
      const fileId = new URL(request.url).searchParams.get("arquivo_id");
      if (!fileId) return fail("Informe o arquivo.");
      const result = await db.from("automacao_arquivos").select("id,storage_path,mime_type").eq("id", fileId)
        .eq("automacao_id", automationId).eq("etapa_id", stageId).maybeSingle();
      if (result.error) return fail("Não foi possível carregar o arquivo.", 500);
      if (!result.data) return fail("Arquivo não encontrado.", 404);
      const path: string | null = result.data.storage_path;
      if (!path) return fail("Este arquivo não possui um caminho no Storage.");
      // Guarda o conteúdo para restaurar o objeto se a exclusão do registro falhar.
      const backup = await storage.download(path);
      if (backup.error) return fail("Não foi possível acessar o PDF para remoção. Tente novamente.", 500);
      const removed = await storage.remove([path]);
      if (removed.error) return fail("Não foi possível remover o PDF do Storage.", 500);
      const deleted = await db.from("automacao_arquivos").delete().eq("id", fileId).eq("automacao_id", automationId).eq("etapa_id", stageId).select("id");
      if (deleted.error || !deleted.data?.length) {
        const restored = await storage.upload(path, backup.data, { contentType: result.data.mime_type || "application/pdf", upsert: false });
        if (restored.error) {
          console.error("Falha ao restaurar PDF após erro na remoção do registro.", { fileId, path });
          return fail("A remoção ficou incompleta. Não foi possível restaurar o PDF; contate o suporte.", 500);
        }
        return fail("Não foi possível remover o registro. O PDF foi preservado; tente novamente.", 500);
      }
      return Response.json({ ok: true });
    }
    return fail("Método não permitido.", 405);
  } catch {
    return fail("Não foi possível concluir a operação. Tente novamente.", 500);
  }
}

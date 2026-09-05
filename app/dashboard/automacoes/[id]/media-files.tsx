"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, ImageIcon, LoaderCircle, Upload } from "lucide-react";
import { validatePdf } from "@/lib/automacoes/pdf";
import { IMAGE_ACCEPT, validateImage } from "@/lib/automacoes/image";

type MediaFile = { id: string; nome: string; tamanho_bytes: number | null };

export function MediaFiles({ automationId, stageId, kind, disabled, onBusyChange }: {
  automationId: string; stageId?: string; kind: "arquivo" | "imagem"; disabled: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const isImage = kind === "imagem";
  const validate = isImage ? validateImage : validatePdf;
  const Icon = isImage ? ImageIcon : FileText;
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [loading, setLoading] = useState(Boolean(stageId));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [retry, setRetry] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const endpoint = `/api/automacoes/${automationId}/arquivos?etapa_id=${encodeURIComponent(stageId ?? "")}`;

  useEffect(() => {
    if (!stageId) return;
    const controller = new AbortController();
    fetch(endpoint, { signal: controller.signal }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Não foi possível carregar os arquivos.");
      setFiles(result.files);
    }).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Não foi possível carregar os arquivos.");
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, stageId, retry]);

  function setWorking(value: boolean) {
    lock.current = value;
    setBusy(value);
    onBusyChange(value);
  }

  async function upload(selected: File[]) {
    if (!stageId || lock.current || !selected.length) return;
    setSuccess("");
    const invalid = selected.find(file => validate(file));
    if (invalid) { setError(`${invalid.name}: ${validate(invalid)}`); return; }
    setWorking(true);
    setUploading(true);
    setError("");
    try {
      for (const file of selected) {
        const body = new FormData();
        body.append("file", file);
        const response = await fetch(endpoint, { method: "POST", body });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`${file.name}: ${result.error || "Não foi possível enviar o arquivo."}`);
        setFiles(current => [...current, result.file]);
      }
      setSuccess(isImage ? "Imagens enviadas com sucesso." : "PDFs enviados com sucesso.");
    } catch (error) {
      setError(`${error instanceof Error ? error.message : "Falha ao enviar arquivo."} Os arquivos já enviados foram mantidos. Selecione novamente apenas os que faltam.`);
    } finally { setUploading(false); setWorking(false); }
  }

  async function remove(file: MediaFile) {
    if (lock.current || !confirm(`Remover "${file.nome}"?`)) return;
    setWorking(true);
    setError("");
    setSuccess("");
    try {
      const response = await fetch(`${endpoint}&arquivo_id=${encodeURIComponent(file.id)}`, { method: "DELETE" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Não foi possível remover o arquivo.");
      setFiles(current => current.filter(item => item.id !== file.id));
      setSuccess("Arquivo removido com sucesso.");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Não foi possível remover o arquivo.");
    } finally { setWorking(false); }
  }

  return <div className="mt-4 rounded-xl border border-dashed border-[#c6ddd0] bg-[#fbfefc] p-4" aria-busy={busy || loading}>
    <p className="text-sm font-semibold text-[#394150]">{isImage ? "Imagem(ns)" : "Arquivos"}</p>
    <p className="mt-1 text-xs text-[#6f7888]">{isImage ? "PNG, JPEG ou WebP de até 10 MB cada." : "PDFs de até 20 MB cada."} Você pode selecionar vários arquivos.</p>
    {!stageId && <p className="mt-3 text-sm text-[#6f7888]">Salve a etapa para habilitar o envio {isImage ? "das imagens" : "dos PDFs"}. O modal continuará aberto.</p>}
    <input ref={picker} type="file" accept={isImage ? IMAGE_ACCEPT : "application/pdf,.pdf"} multiple className="hidden" disabled={!stageId || busy || loading || disabled}
      onChange={event => { const selected = Array.from(event.target.files ?? []); event.target.value = ""; void upload(selected); }} />
    <button type="button" disabled={!stageId || busy || loading || disabled} onClick={() => picker.current?.click()}
      className="mt-3 inline-flex items-center gap-2 rounded-xl bg-[#e2f2e7] px-4 py-2 text-sm font-semibold text-[#286342] disabled:cursor-not-allowed disabled:opacity-50">
      {uploading ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}{uploading ? (isImage ? "Enviando imagem..." : "Enviando PDF...") : (isImage ? "Selecionar imagem" : "Selecionar PDF")}
    </button>
    {loading ? <p role="status" className="mt-3 text-sm text-[#6f7888]">Carregando arquivos...</p> : files.length > 0 ? <>
      <p className="mt-4 text-sm font-medium">Arquivos adicionados</p>
      <ul className="mt-2 space-y-2">{files.map(file => <li key={file.id} className="flex items-center gap-2 rounded-lg border border-[#dfede3] bg-white p-3">
        <Icon className="size-4 shrink-0 text-[#286342]" /><span className="min-w-0 flex-1 break-words text-sm">{file.nome}</span>
        <button type="button" disabled={busy || loading || disabled} onClick={() => void remove(file)} className="shrink-0 text-sm text-red-600 disabled:opacity-50" aria-label={`Remover ${file.nome}`}>Remover</button>
      </li>)}</ul>
    </> : stageId && <p className="mt-3 text-sm text-[#6f7888]">{isImage ? "Nenhuma imagem adicionada." : "Nenhum PDF adicionado."}</p>}
    {stageId && <p className="mt-3 text-xs text-[#6f7888]">Envios e remoções são salvos imediatamente.</p>}
    {success && <p role="status" className="mt-3 text-sm text-[#286342]">{success}</p>}
    {error && <div role="alert" className="mt-3 text-sm text-red-600"><p>{error}</p><button type="button" disabled={busy || loading || disabled} onClick={() => { setLoading(true); setError(""); setRetry(value => value + 1); }} className="mt-2 underline">Atualizar lista</button></div>}
  </div>;
}

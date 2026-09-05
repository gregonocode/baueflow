"use client";

import Link from "next/link";
import { ArrowLeft, Bot, Check, CircleDollarSign, FileText, Mail, MessageSquareText, Plus, Save, Settings2, Trash2, Video, Zap } from "lucide-react";
import { useState } from "react";

type Config = Record<string, unknown>;
type S = { id: string; nome: string; tipo: string; config: Config; position_y: number };
type E = { id?: string; origem_etapa_id: string; destino_etapa_id: string; chave_saida: string; label?: string | null; ordem?: number };
type F = { id: string; etapa_id: string; nome: string };
type A = { id: string; nome: string; gatilho: string | null; status: string; etapa_inicial_id: string | null; iniciar_novas_conversas: boolean };
type Option = { id: string; label: string };

const meta = { mensagem: MessageSquareText, video: Video, arquivo: FileText, opcoes: Bot, capturar_email: Mail, acao_api: Settings2, pix: CircleDollarSign, espera: Zap, fim: Check };
const kinds = Object.keys(meta);
const input = "mt-1 h-10 w-full rounded-xl border border-[#d8e4dc] bg-white px-3 text-sm outline-none focus:border-[#286342]";

function initialConfig(tipo: string): Config {
  switch (tipo) {
    case "video": return { url: "", caption: "" };
    case "arquivo": return { arquivos: [] };
    case "opcoes": return { texto: "", opcoes: [] };
    case "capturar_email": return { mensagem: "", validar: true, mensagem_invalida: "" };
    case "acao_api": return { url: "", method: "POST", headers: {}, body: {} };
    case "pix": return { valor_centavos: 0, descricao: "", mensagem: "", codigo_pix: "", texto_botao: "Copiar Pix" };
    case "espera": return { segundos: 2 };
    case "fim": return { mensagem: "" };
    default: return { texto: "" };
  }
}

function optionsOf(config: Config): Option[] {
  return Array.isArray(config.opcoes) ? config.opcoes.filter((item): item is Option => typeof item === "object" && item !== null && typeof (item as Option).id === "string" && typeof (item as Option).label === "string") : [];
}
function preview(stage: S, files: F[]) {
  const c = stage.config;
  if (stage.tipo === "video") return String(c.caption || c.url || "Configure esta etapa.");
  if (stage.tipo === "arquivo") return files.filter(file => file.etapa_id === stage.id).map(file => file.nome).join(", ") || "Nenhum arquivo associado.";
  if (stage.tipo === "opcoes") return `${optionsOf(c).length} opções configuradas`;
  if (stage.tipo === "acao_api") return `${String(c.method || "POST")} ${String(c.url || "")}`.trim();
  if (stage.tipo === "pix") return `R$ ${((Number(c.valor_centavos) || 0) / 100).toFixed(2).replace(".", ",")}${c.descricao ? ` · ${c.descricao}` : ""}${String(c.codigo_pix ?? "").trim() ? " · Botão de copiar Pix" : " · Somente mensagem"}`;
  if (stage.tipo === "espera") return `Esperar ${Number(c.segundos) || 0} segundos`;
  if (stage.tipo === "fim") return String(c.mensagem || "Finalizar automação");
  return String(c.texto ?? c.mensagem ?? "Configure esta etapa.");
}

export function AutomationEditor({ automation: seed, stages, connections: seedEdges, files }: { automation: A; stages: S[]; connections: E[]; files: F[] }) {
  const [a, setA] = useState(seed);
  const [edges, setEdges] = useState(seedEdges);
  const [edit, setEdit] = useState<S | null | undefined>();
  const api = (x: unknown) => fetch(`/api/automacoes/${a.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(x) });
  const setEdge = async (origem: string, key: string, destino: string, label: string) => {
    await api({ action: "set-connection", origem, key, destino, label });
    setEdges(current => [...current.filter(edge => !(edge.origem_etapa_id === origem && edge.chave_saida === key)), ...(destino ? [{ origem_etapa_id: origem, destino_etapa_id: destino, chave_saida: key, label }] : [])]);
  };
  const saveStage = async (stage: S, destinations: Record<string, string>) => {
    const response = await api(edit ? { action: "update-stage", stage } : { action: "create-stage", stage: { ...stage, position_y: (stages.length + 1) * 100 } });
    if (!response.ok) return;
    const result = await response.json().catch(() => ({}));
    const stageId = edit?.id ?? result.stage?.id;
    if (stage.tipo === "opcoes" && stageId) {
      const previous = edit ? optionsOf(edit.config) : [];
      const current = optionsOf(stage.config);
      await Promise.all([
        ...current.map(option => setEdge(stageId, option.id, destinations[option.id] || "", option.label)),
        ...previous.filter(option => !current.some(currentOption => currentOption.id === option.id)).map(option => setEdge(stageId, option.id, "", option.label)),
      ]);
    }
    location.reload();
  };
  return <div className="mx-auto w-full max-w-[1180px] pb-24">
    <header className="mb-7 flex justify-between"><div><Link href="/dashboard/automacoes" className="mb-4 inline-flex gap-2 text-sm text-[#6f7888]"><ArrowLeft className="size-4" />Voltar para automações</Link><h1 className="text-3xl font-bold">{a.nome}</h1></div><button onClick={() => api({ action: "update-automation", ...a })} className="rounded-xl bg-[#286342] px-5 py-3 text-sm font-semibold text-white"><Save className="mr-2 inline size-4" />Salvar automação</button></header>
    <section className="rounded-2xl border border-[#dfede3] bg-[#fbfefc] p-5"><div className="grid gap-4 sm:grid-cols-2"><label>Nome<input value={a.nome} onChange={e => setA({ ...a, nome: e.target.value })} className={input} /></label><label>Status<select value={a.status} onChange={e => setA({ ...a, status: e.target.value })} className={input}><option value="rascunho">Rascunho</option><option value="ativa">Ativa</option><option value="pausada">Pausada</option></select></label></div><label className="mt-4 flex gap-3 rounded-xl border p-3"><input type="checkbox" checked={a.iniciar_novas_conversas} onChange={e => setA({ ...a, iniciar_novas_conversas: e.target.checked })} /><span><b>Iniciar automaticamente em novas conversas</b><small className="block">Quando um novo contato enviar a primeira mensagem, esta automação será iniciada.</small></span></label><label className="mt-4 block">Gatilho opcional<small className="block">Use apenas para iniciar uma automação específica por mensagem.</small><input value={a.gatilho ?? ""} onChange={e => setA({ ...a, gatilho: e.target.value })} className={input} /></label></section>
    <div className="mt-8 flex justify-between"><h2 className="text-xl font-bold">FLUXO DA AUTOMAÇÃO</h2><button onClick={() => setEdit(null)} className="rounded-xl bg-[#e2f2e7] px-4 py-2 text-sm font-semibold text-[#286342]"><Plus className="mr-2 inline size-4" />Adicionar etapa</button></div>
    <div className="mt-5 space-y-3">{stages.map((stage, i) => { const Icon = meta[stage.tipo as keyof typeof meta] ?? Bot; const edge = (key: string) => edges.find(item => item.origem_etapa_id === stage.id && item.chave_saida === key)?.destino_etapa_id ?? ""; return <section key={stage.id} className="rounded-2xl border border-[#dfede3] bg-[#fbfefc] p-5"><div className="flex gap-4"><Icon className="size-5 text-[#286342]" /><div><p className="text-xs font-bold text-[#3f7655]">{String(i + 1).padStart(2, "0")} · {stage.tipo.toUpperCase()}</p><h3 className="font-semibold">{stage.nome}{a.etapa_inicial_id === stage.id && <span className="ml-2 rounded bg-[#e3f4e8] px-2 text-xs">INICIAL</span>}</h3><p className="text-sm text-[#858c9c]">{preview(stage, files)}</p></div></div><div className="mt-4 flex flex-wrap gap-2 border-t pt-4">{stage.tipo === "opcoes" ? optionsOf(stage.config).map(option => <Select key={option.id} label={option.label} value={edge(option.id)} stages={stages} currentStageId={stage.id} change={value => setEdge(stage.id, option.id, value, option.label)} />) : stage.tipo !== "fim" && <Select label="Próxima etapa" value={edge("default")} stages={stages} currentStageId={stage.id} change={value => setEdge(stage.id, "default", value, "default")} />}{a.etapa_inicial_id === stage.id ? <span className="self-end px-3 py-2 text-sm font-medium text-[#286342]">Etapa inicial</span> : <button onClick={() => api({ action: "set-initial", stageId: stage.id }).then(() => setA({ ...a, etapa_inicial_id: stage.id }))}>Definir como inicial</button>}<button onClick={() => setEdit(stage)}>Editar</button><button onClick={() => { if (confirm("Excluir etapa?")) api({ action: "delete-stage", stageId: stage.id }).then(() => location.reload()); }}><Trash2 className="size-4 text-red-600" /></button></div></section>; })}</div>
    {edit !== undefined && <Modal stage={edit} stages={stages} files={files} edges={edges} close={() => setEdit(undefined)} save={saveStage} />}
  </div>;
}

function Select({ label, value, stages, currentStageId, change }: { label: string; value: string; stages: S[]; currentStageId: string; change: (x: string) => void }) { return <label className="text-sm">{label}<select value={value} onChange={e => change(e.target.value)} className={input}><option value="">Nenhuma</option>{stages.filter(stage => stage.id !== currentStageId).map(stage => <option key={stage.id} value={stage.id}>{stage.nome}</option>)}</select></label>; }

function Modal({ stage, stages, files, edges, close, save }: { stage: S | null; stages: S[]; files: F[]; edges: E[]; close: () => void; save: (stage: S, destinations: Record<string, string>) => void }) {
  const [tipo, setTipo] = useState(stage?.tipo ?? "mensagem"); const [nome, setNome] = useState(stage?.nome ?? ""); const [config, setConfig] = useState<Config>(stage?.config ?? initialConfig("mensagem"));
  const [bodyText, setBodyText] = useState(JSON.stringify(stage?.config.body ?? {}, null, 2)); const [headersText, setHeadersText] = useState(JSON.stringify(stage?.config.headers ?? {}, null, 2)); const [jsonError, setJsonError] = useState("");
  const [destinations, setDestinations] = useState<Record<string, string>>(() => Object.fromEntries(optionsOf(stage?.config ?? {}).map(option => [option.id, edges.find(edge => edge.origem_etapa_id === stage?.id && edge.chave_saida === option.id)?.destino_etapa_id ?? ""])));
  const update = (key: string, value: unknown) => setConfig(current => ({ ...current, [key]: value })); const changeType = (next: string) => { setTipo(next); setConfig(initialConfig(next)); setBodyText("{}"); setHeadersText("{}"); setJsonError(""); setDestinations({}); }; const options = optionsOf(config);
  const saveModal = () => { let nextConfig = config; if (tipo === "acao_api") try { nextConfig = { ...config, body: JSON.parse(bodyText || "{}"), headers: JSON.parse(headersText || "{}") }; } catch { setJsonError("Body e headers precisam conter JSON válido."); return; } save({ id: stage?.id ?? "", nome: nome || tipo, tipo, config: nextConfig, position_y: stage?.position_y ?? 0 }, destinations); };
  return <div className="fixed inset-0 z-50 overflow-y-auto bg-black/30 p-4"><div className="mx-auto my-8 w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl"><h2 className="text-xl font-bold">{stage ? "Editar etapa" : "Nova etapa"}</h2>{!stage && <label className="mt-3 block text-sm font-medium">Tipo<select value={tipo} onChange={e => changeType(e.target.value)} className={input}>{kinds.map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></label>}<label className="mt-3 block text-sm font-medium">Nome da etapa<input value={nome} onChange={e => setNome(e.target.value)} className={input} placeholder={tipo} /></label><StageFields tipo={tipo} config={config} update={update} files={files.filter(file => file.etapa_id === stage?.id)} options={options} setOptions={value => update("opcoes", value)} destinations={destinations} setDestinations={setDestinations} stages={stages} currentStageId={stage?.id ?? ""} bodyText={bodyText} setBodyText={setBodyText} headersText={headersText} setHeadersText={setHeadersText} />{jsonError && <p className="mt-3 text-sm text-red-600">{jsonError}</p>}<div className="mt-6 flex justify-end gap-3"><button onClick={close}>Cancelar</button><button onClick={saveModal} className="rounded-xl bg-[#286342] px-4 py-2 text-sm font-semibold text-white">Salvar etapa</button></div></div></div>;
}

function StageFields({ tipo, config, update, files, options, setOptions, destinations, setDestinations, stages, currentStageId, bodyText, setBodyText, headersText, setHeadersText }: { tipo: string; config: Config; update: (key: string, value: unknown) => void; files: F[]; options: Option[]; setOptions: (options: Option[]) => void; destinations: Record<string, string>; setDestinations: (value: Record<string, string>) => void; stages: S[]; currentStageId: string; bodyText: string; setBodyText: (value: string) => void; headersText: string; setHeadersText: (value: string) => void }) {
  const text = (label: string, key: string, multiline = false) => <label className="mt-3 block text-sm font-medium text-[#394150]">{label}{multiline ? <textarea value={String(config[key] ?? "")} onChange={e => update(key, e.target.value)} className="mt-1 min-h-28 w-full rounded-xl border border-[#d8e4dc] p-3 text-sm" /> : <input value={String(config[key] ?? "")} onChange={e => update(key, e.target.value)} className={input} />}</label>;
  if (tipo === "mensagem") return <>{text("Mensagem", "texto", true)}<p className="mt-2 text-xs text-[#6f7888]">Variáveis disponíveis: {"{{nome}}"} · {"{{telefone}}"} · {"{{email}}"}</p></>;
  if (tipo === "video") return <>{text("URL do vídeo", "url")}{text("Legenda opcional", "caption", true)}</>;
  if (tipo === "arquivo") return <div className="mt-3 rounded-xl border border-dashed border-[#c6ddd0] p-4"><p className="text-sm font-medium">Arquivos associados</p><div className="mt-2 text-sm text-[#6f7888]">{files.length ? files.map(file => <p key={file.id}>{file.nome}</p>) : "Nenhum arquivo associado."}</div><button type="button" className="mt-3 text-sm font-semibold text-[#286342]">+ Adicionar arquivo</button></div>;
  if (tipo === "opcoes") return <><label className="mt-3 block text-sm font-medium">Pergunta<textarea value={String(config.texto ?? "")} onChange={e => update("texto", e.target.value)} className="mt-1 min-h-24 w-full rounded-xl border border-[#d8e4dc] p-3 text-sm" /></label><p className="mt-4 text-sm font-semibold">Opções</p>{options.map((option, index) => <div key={`${option.id}-${index}`} className="mt-2 rounded-xl border p-3"><label className="block text-sm">Texto<input value={option.label} onChange={e => setOptions(options.map((item, position) => position === index ? { ...item, label: e.target.value } : item))} className={input} /></label><label className="mt-2 block text-sm">ID interno<input value={option.id} readOnly className={`${input} bg-[#f4f7f5] text-[#6f7888]`} /></label><Select label="Próxima etapa" value={destinations[option.id] ?? ""} stages={stages} currentStageId={currentStageId} change={value => setDestinations({ ...destinations, [option.id]: value })} /><button type="button" onClick={() => { setOptions(options.filter((_, position) => position !== index)); const next = { ...destinations }; delete next[option.id]; setDestinations(next); }} className="mt-3 text-sm text-red-600">Remover</button></div>)}<button type="button" onClick={() => { const nextNumber = Math.max(0, ...options.map(option => Number(option.id.replace(/^opcao_/, "")) || 0)) + 1; const id = `opcao_${nextNumber}`; setOptions([...options, { id, label: "" }]); }} className="mt-3 text-sm font-semibold text-[#286342]">+ Adicionar opção</button></>;
  if (tipo === "capturar_email") return <>{text("Mensagem para pedir e-mail", "mensagem", true)}<label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(config.validar)} onChange={e => update("validar", e.target.checked)} />Validar e-mail</label>{text("Mensagem caso seja inválido", "mensagem_invalida", true)}</>;
  if (tipo === "acao_api") return <><label className="mt-3 block text-sm">URL<input value={String(config.url ?? "")} onChange={e => update("url", e.target.value)} className={input} /></label><label className="mt-3 block text-sm">Método<select value={String(config.method ?? "POST")} onChange={e => update("method", e.target.value)} className={input}><option>POST</option><option>PUT</option><option>PATCH</option></select></label><label className="mt-3 block text-sm">Body JSON<textarea value={bodyText} onChange={e => setBodyText(e.target.value)} className="mt-1 min-h-28 w-full rounded-xl border p-3 font-mono text-sm" /></label><label className="mt-3 block text-sm">Headers JSON opcional<textarea value={headersText} onChange={e => setHeadersText(e.target.value)} className="mt-1 min-h-24 w-full rounded-xl border p-3 font-mono text-sm" /></label><p className="mt-2 text-xs text-[#6f7888]">Variáveis possíveis: {"{{email}}"} · {"{{telefone}}"} · {"{{nome}}"}</p></>;
  if (tipo === "pix") {
    const reais = ((Number(config.valor_centavos) || 0) / 100).toFixed(2).replace(".", ",");
    return <>
      <label className="mt-3 block text-sm">Valor a informar<div className="mt-1 flex h-10 items-center rounded-xl border border-[#d8e4dc] px-3"><span className="mr-2 text-sm text-[#6f7888]">R$</span><input value={reais} onChange={e => update("valor_centavos", Number(e.target.value.replace(/\D/g, "") || 0))} className="w-full outline-none" inputMode="decimal" /></div></label>
      {text("Título da mensagem", "descricao")}
      {text("Mensagem", "mensagem", true)}
      {text("Chave Pix ou código Copia e Cola", "codigo_pix", true)}
      <p className="mt-2 text-xs text-[#6f7888]">Cole sua chave Pix ou o código Copia e Cola do banco. O botão copia esse conteúdo; o valor informado acima não altera o código. Deixe vazio para enviar somente a mensagem.</p>
      {text("Texto do botão (padrão: Copiar Pix)", "texto_botao")}
      <p className="mt-3 rounded-xl bg-[#f4f7f5] p-3 text-xs text-[#6f7888]">Após enviar, o fluxo segue para a próxima etapa sem aguardar pagamento.</p>
    </>;
  }
  if (tipo === "espera") { const seconds = Number(config.segundos) || 0; const minutes = seconds > 0 && seconds % 60 === 0; return <div className="mt-3 grid grid-cols-2 gap-3"><label className="text-sm">Quantidade<input type="number" min="1" value={minutes ? seconds / 60 : seconds} onChange={e => update("segundos", Number(e.target.value || 0) * (minutes ? 60 : 1))} className={input} /></label><label className="text-sm">Unidade<select value={minutes ? "minutos" : "segundos"} onChange={e => update("segundos", e.target.value === "minutos" ? Math.max(1, seconds) * 60 : (minutes ? seconds / 60 : seconds))} className={input}><option value="segundos">segundos</option><option value="minutos">minutos</option></select></label></div>; }
  return text("Mensagem final opcional", "mensagem", true);
}

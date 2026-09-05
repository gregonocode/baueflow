import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { executarAutomacao } from "../lib/automacoes/executor.ts";
import { sendMedia, sendText } from "../lib/evolution.ts";
import { POST } from "../app/api/evolution/webhook/route.ts";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let tables, sends, apiCalls, faults, logs;
const originalConsole = { log: console.log, warn: console.warn, error: console.error };

function get(row, key) {
  return key.split("->>").reduce((value, part) => value?.[part], row);
}

// Simula o contrato HTTP PostgREST, mantendo o Supabase client real nos testes.
// Os índices são simulados aqui; a migration deve ser aplicada no Postgres real.
async function fakeFetch(input, init = {}) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init.method ?? (input instanceof Request ? input.method : "GET");
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  const raw = init.body ?? (input instanceof Request && method !== "GET" ? await input.text() : null);
  const body = raw ? JSON.parse(raw) : undefined;
  if (url.hostname === "evolution.test") {
    sends.push({ path: url.pathname, body, headers });
    if (faults.sendGate) await faults.sendGate;
    if (faults.sendThrows) throw new Error("network details with secret");
    if (faults.sendStatus) return new Response(faults.sendResponse ?? "rejected", { status: faults.sendStatus });
    return Response.json({ key: { id: `out-${sends.length}` } }, { status: 201 });
  }
  if (url.hostname === "action.test") {
    apiCalls.push({ method, body, headers, signal: init.signal, redirect: init.redirect });
    if (faults.apiThrows) throw new Error("secret-header-value");
    return new Response(null, { status: faults.apiStatus ?? 204 });
  }
  assert.equal(url.hostname, "supabase.test", "Nenhuma requisição real permitida nos testes");
  const name = url.pathname.split("/").at(-1);
  const rows = tables[name];
  assert.ok(rows, `Tabela inesperada: ${name}`);
  if (faults.db?.(name, method, body)) return Response.json({ code: "XX000", message: "secret-db-error" }, { status: 500 });
  const filters = [...url.searchParams.entries()].filter(([key]) => !["select", "order", "limit", "or"].includes(key));
  let selected = rows.filter(row => filters.every(([key, value]) => {
    const [op, ...tail] = value.split(".");
    const expected = tail.join(".");
    assert.equal(op, "eq");
    return String(get(row, key)) === expected;
  }));
  if (url.searchParams.has("or")) {
    selected = selected.filter(row => row.execucao_token == null || new Date(row.execucao_ate) < new Date());
  }
  const order = url.searchParams.get("order");
  if (order) {
    const [key, direction] = order.split(".");
    selected.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (direction === "desc" ? -1 : 1));
  }
  if (url.searchParams.has("limit")) selected = selected.slice(0, Number(url.searchParams.get("limit")));
  if (method === "POST") {
    if (name === "whatsapp_mensagens" && body.direcao === "entrada" && rows.some(row => row.direcao === "entrada" && row.external_message_id === body.external_message_id && row.payload.instance === body.payload.instance)) {
      return Response.json({ code: "23505", message: "duplicate" }, { status: 409 });
    }
    if (name === "whatsapp_conversas" && rows.some(row => row.status === "ativa" && row.user_id === body.user_id && row.telefone === body.telefone && row.dados?.instancia === body.dados?.instancia)) {
      return Response.json({ code: "23505", message: "duplicate" }, { status: 409 });
    }
    const row = { id: `${name}-${rows.length + 1}`, created_at: new Date().toISOString(), ...structuredClone(body) };
    rows.push(row);
    selected = [row];
  } else if (method === "PATCH") {
    selected.forEach(row => Object.assign(row, structuredClone(body)));
  }
  const representation = method === "GET" || (headers.get("prefer") ?? "").includes("return=representation");
  if (!representation) return new Response(null, { status: 204 });
  if ((headers.get("accept") ?? "").includes("vnd.pgrst.object")) {
    if (selected.length !== 1) return Response.json({ code: "PGRST116", details: `The result contains ${selected.length} rows` }, { status: 406 });
    return Response.json(selected[0]);
  }
  return Response.json(selected);
}

beforeEach(() => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service-secret",
    EVOLUTION_API_URL: "https://evolution.test", EVOLUTION_API_KEY: "evolution-secret",
    EVOLUTION_WEBHOOK_SECRET: "webhook-secret", NODE_ENV: "test",
  });
  delete process.env.EVOLUTION_INSTANCE;
  delete process.env.BAUEFLOW_OWNER_USER_ID;
  tables = {
    whatsapp_conversas: [], whatsapp_mensagens: [],
    whatsapp_instancias: [{ user_id: "user-1", instance_name: "instancia-1", status: "ativa" }],
    automacoes: [{ id: "automation-1", user_id: "user-1", status: "ativa", iniciar_novas_conversas: true, etapa_inicial_id: "start" }],
    automacao_etapas: [], automacao_conexoes: [], automacao_arquivos: [],
  };
  sends = []; apiCalls = []; faults = {}; logs = [];
  globalThis.fetch = fakeFetch;
  for (const method of ["log", "warn", "error"]) console[method] = (...args) => logs.push(JSON.stringify(args));
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(console, originalConsole);
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

function stage(id, tipo, config = {}) { tables.automacao_etapas.push({ id, tipo, config, nome: id, automacao_id: "automation-1" }); }
function edge(from, to, key = "default") { tables.automacao_conexoes.push({ automacao_id: "automation-1", origem_etapa_id: from, destino_etapa_id: to, chave_saida: key }); }
function conversation(stageId = "start", dados = {}) {
  const row = { id: "conversation-1", user_id: "user-1", automacao_id: "automation-1", etapa_atual_id: stageId, telefone: "5585999999999", nome_contato: "Tiago", email: null, escolha: null, status: "ativa", dados: { estado: "iniciada", instancia: "instancia-1", custom: "preservar", ...dados } };
  tables.whatsapp_conversas.push(row);
  return row;
}
function request(message, id = "in-1", extra = {}) {
  return new Request("https://app.test/api/evolution/webhook", {
    method: "POST", headers: { "x-baueflow-secret": "webhook-secret", "Content-Type": "application/json" },
    body: JSON.stringify({ event: "MESSAGES_UPSERT", instance: "instancia-1", apikey: "do-not-persist", data: {
      key: { id, fromMe: false, remoteJid: "5585999999999@s.whatsapp.net" }, pushName: "Tiago",
      message: { conversation: message }, messageType: "conversation", ...extra,
    } }),
  });
}
const execute = (extra = {}) => executarAutomacao({ conversaId: "conversation-1", ...extra });

test("funil completo pelo webhook: mensagem → vídeo → opções → arquivos → email → API → fim", async () => {
  stage("start", "mensagem", { texto: "Olá {{nome}} / {{email}}" });
  stage("video", "video", { url: "https://storage.test/demo.mp4", caption: "Para {{nome}}" });
  stage("options", "opcoes", { texto: "Qual deseja?", opcoes: [{ id: "basico", label: "Básico R$10" }, { id: "completo", label: "Completo R$17" }] });
  stage("files", "arquivo");
  stage("email", "capturar_email", { mensagem: "Seu e-mail, {{nome}}?", validar: true });
  stage("api", "acao_api", { url: "https://action.test/lead", method: "PATCH", headers: { Authorization: "secret-header-value", "X-Email": "{{email}}" }, body: { contact: { email: "{{email}}", name: "{{nome}}" }, phones: ["{{telefone}}"], n: 7, nil: null } });
  stage("thanks", "mensagem", { texto: "Enviado para {{email}}" });
  stage("end", "fim", { mensagem: "Até mais, {{nome}}" });
  edge("start", "video"); edge("video", "options"); edge("options", "files", "completo");
  edge("files", "email"); edge("email", "api"); edge("api", "thanks"); edge("thanks", "end");
  tables.automacao_arquivos.push(
    { automacao_id: "automation-1", etapa_id: "files", ordem: 2, nome: "Aula.mp4", tipo: "video", public_url: "https://storage.test/aula.mp4" },
    { automacao_id: "automation-1", etapa_id: "files", ordem: 1, nome: "Guia.pdf", tipo: "pdf", public_url: "https://storage.test/guia.pdf" },
  );
  assert.equal((await POST(request("2"))).status, 200);
  const convo = tables.whatsapp_conversas[0];
  assert.equal(convo.dados.estado, "aguardando_opcao");
  assert.equal(sends.length, 3, "A primeira mensagem não pode escolher a opção");
  assert.equal(sends[0].body.text, "Olá Tiago / ");
  assert.equal(sends[1].body.mediatype, "video");
  assert.equal(sends[1].body.caption, "Para Tiago");
  assert.match(sends[2].body.text, /2 - Completo R\$17/);
  assert.equal((await POST(request("2", "in-2"))).status, 200);
  assert.equal(convo.escolha, "completo");
  assert.equal(convo.dados.estado, "aguardando_email");
  assert.equal(convo.email, undefined, "A opção não pode virar resposta de e-mail");
  assert.equal(sends[3].body.fileName, "Guia.pdf");
  assert.equal(sends[3].body.mediatype, "document");
  assert.equal(sends[4].body.fileName, "Aula.mp4");
  assert.equal((await POST(request("tiago@example.com", "in-3"))).status, 200);
  assert.equal(convo.email, "tiago@example.com");
  assert.equal(convo.status, "finalizada");
  assert.equal(convo.etapa_atual_id, null);
  assert.equal(convo.execucao_token, null);
  assert.equal(apiCalls.length, 1);
  assert.deepEqual(apiCalls[0].body, { contact: { email: "tiago@example.com", name: "Tiago" }, phones: ["5585999999999"], n: 7, nil: null });
  assert.equal(apiCalls[0].headers.get("x-email"), "tiago@example.com");
  assert.equal(apiCalls[0].method, "PATCH");
  assert.equal(apiCalls[0].redirect, "error");
  assert.ok(apiCalls[0].signal instanceof AbortSignal);
  const outgoing = tables.whatsapp_mensagens.filter(row => row.direcao === "saida");
  assert.equal(outgoing.length, sends.length);
  assert.ok(outgoing.every(row => row.status === "enviada" && row.external_message_id.startsWith("out-")));
  assert.ok(tables.whatsapp_mensagens.filter(row => row.direcao === "entrada").every(row => !row.payload.apikey));
  const before = sends.length;
  assert.equal((await (await POST(request("tiago@example.com", "in-3"))).json()).duplicate, true);
  assert.equal(sends.length, before);
  assert.equal(tables.whatsapp_conversas.length, 1, "Reentrega após fim não reinicia o funil");
  assert.ok(!logs.join().includes("secret-header-value"));
});

for (const answer of ["1", "basico", "bÁSICO r$10"]) {
  test(`opção determinística aceita ${answer}`, async () => {
    const convo = conversation("start", { estado: "aguardando_opcao", etapa_espera_id: "start" });
    stage("start", "opcoes", { texto: "Escolha", opcoes: [{ id: "basico", label: "Básico R$10" }] });
    stage("end", "fim"); edge("start", "end", "basico");
    await execute({ mensagemRecebida: answer });
    assert.equal(convo.escolha, "basico"); assert.equal(convo.status, "finalizada");
    assert.equal(convo.dados.custom, "preservar"); assert.equal(sends.length, 0);
  });
}

test("opção desconhecida repete instrução/menu e mantém espera", async () => {
  const convo = conversation("start", { estado: "aguardando_opcao", etapa_espera_id: "start" });
  stage("start", "opcoes", { texto: "Escolha", opcoes: [{ id: "basico", label: "Básico" }] });
  await execute({ mensagemRecebida: "quero básico talvez" });
  assert.equal(sends.length, 2); assert.match(sends[0].body.text, /Não consegui identificar/);
  assert.equal(convo.dados.estado, "aguardando_opcao"); assert.equal(convo.etapa_atual_id, "start");
});

test("espera sem mensagem não reenvia a pergunta; nova conversa ignora resposta", async () => {
  conversation("start", { estado: "aguardando_email", etapa_espera_id: "start" });
  stage("start", "capturar_email", { mensagem: "Seu email?" });
  await execute(); assert.equal(sends.length, 0);
  await execute({ mensagemRecebida: "hello@example.com", isNewConversation: true });
  assert.equal(sends.length, 1); assert.equal(tables.whatsapp_conversas[0].email, null);
});

for (const custom of ["", "Inválido, {{nome}}!"]) {
  test(`email inválido usa ${custom ? "mensagem configurada" : "fallback"}`, async () => {
    const convo = conversation("start", { estado: "aguardando_email" });
    stage("start", "capturar_email", { mensagem: "Email?", validar: true, mensagem_invalida: custom });
    await execute({ mensagemRecebida: "nao-e-email" });
    assert.equal(convo.email, null); assert.equal(convo.dados.estado, "aguardando_email");
    assert.equal(sends[0].body.text, custom ? "Inválido, Tiago!" : "Esse e-mail parece inválido. Pode enviar novamente?");
  });
}

test("config.validar=false respeita a opção do editor", async () => {
  const convo = conversation("start", { estado: "aguardando_email" });
  stage("start", "capturar_email", { validar: false }); stage("end", "fim"); edge("start", "end");
  await execute({ mensagemRecebida: " informado " });
  assert.equal(convo.email, "informado"); assert.equal(convo.status, "finalizada");
});

test("falha API mantém etapa, marca erro e não vaza headers/resposta", async () => {
  const convo = conversation();
  stage("start", "acao_api", { url: "https://action.test/run", headers: { Authorization: "secret-header-value" }, body: {} });
  stage("end", "fim", { mensagem: "Nunca enviar" }); edge("start", "end");
  faults.apiStatus = 500;
  await assert.rejects(execute(), /HTTP 500/);
  assert.equal(convo.dados.estado, "erro"); assert.equal(convo.etapa_atual_id, "start");
  assert.equal(sends.length, 0); assert.equal(convo.execucao_token, null);
  assert.ok(!logs.join().includes("secret-header-value"));
  await execute({ mensagemRecebida: "oi" }); assert.equal(apiCalls.length, 1, "Erro não provoca reenvio automático");
});

test("Evolution 2.3.7 usa payload plano, instance parametrizada e URL pública", async () => {
  await sendText({ instance: "cliente / 2", number: "5585999999999", text: "Olá" });
  await sendMedia({ instance: "outra", number: "5585999999999", mediaUrl: "https://storage.test/doc.pdf", mediaType: "document", fileName: "doc.pdf", caption: "Guia" });
  assert.equal(sends[0].path, "/message/sendText/cliente%20%2F%202");
  assert.deepEqual(sends[0].body, { number: "5585999999999", text: "Olá" });
  assert.deepEqual(sends[1].body, { number: "5585999999999", mediatype: "document", media: "https://storage.test/doc.pdf", fileName: "doc.pdf", caption: "Guia" });
  assert.equal(sends[0].headers.get("apikey"), "evolution-secret");
});

test("Evolution não-2xx registra status/resposta com segredos removidos", async () => {
  faults.sendStatus = 401;
  faults.sendResponse = JSON.stringify({ error: "recusado", apikey: "evolution-secret", token: "service-secret" });
  await assert.rejects(sendText({ instance: "instancia-1", number: "5585999999999", text: "Olá" }), /HTTP 401/);
  assert.match(logs.join(), /401/); assert.match(logs.join(), /recusado/);
  assert.ok(!logs.join().includes("evolution-secret")); assert.ok(!logs.join().includes("service-secret"));
});

test("falha de envio não registra sucesso nem avança", async () => {
  const convo = conversation(); stage("start", "mensagem", { texto: "Olá" }); stage("end", "fim"); edge("start", "end");
  faults.sendThrows = true;
  await assert.rejects(execute());
  assert.equal(convo.etapa_atual_id, "start"); assert.equal(convo.dados.estado, "erro");
  assert.equal(tables.whatsapp_mensagens.length, 0);
});

test("sem conexão pausa após um único envio", async () => {
  const convo = conversation(); stage("start", "mensagem", { texto: "Olá" });
  await execute(); await execute({ mensagemRecebida: "oi" });
  assert.equal(sends.length, 1); assert.equal(convo.dados.estado, "pausada");
});

test("ciclo para no limite de 30 etapas", async () => {
  const convo = conversation(); stage("start", "mensagem", { texto: "Loop" }); edge("start", "start");
  await assert.rejects(execute(), /30 etapas/);
  assert.equal(sends.length, 30); assert.equal(convo.dados.estado, "erro");
});

for (const env of ["production", "development"]) {
  test(`Pix sem gateway em ${env} para sem avançar`, async () => {
    process.env.NODE_ENV = env;
    const convo = conversation(); stage("start", "pix", { mensagem: "Pagamento, {{nome}}", valor_centavos: 1700 });
    stage("end", "fim", { mensagem: "Pago!" }); edge("start", "end");
    await execute();
    assert.equal(sends.length, env === "production" ? 1 : 2);
    if (env !== "production") assert.equal(sends[1].body.text, "[PIX pendente de integração: R$ 17,00]");
    assert.equal(convo.etapa_atual_id, "start"); assert.equal(convo.dados.estado, "pausada");
    assert.match(logs.join(), /PIX gateway not configured/);
  });
}

test("espera curta avança e espera longa pausa", async () => {
  const convo = conversation(); stage("start", "espera", { segundos: 0.001 }); stage("long", "espera", { segundos: 11 }); edge("start", "long");
  await execute(); assert.equal(convo.etapa_atual_id, "long"); assert.equal(convo.dados.estado, "pausada"); assert.equal(sends.length, 0);
});

test("instância registrada não pode usar cadastro de outro usuário", async () => {
  const convo = conversation(); stage("start", "mensagem", { texto: "Oi" });
  tables.whatsapp_instancias[0].user_id = "outro";
  tables.whatsapp_instancias.push({ user_id: "user-1", instance_name: "outra", status: "ativa" });
  await assert.rejects(execute(), /Instância ativa/);
  assert.equal(sends.length, 0); assert.equal(convo.dados.estado, "erro");
});

test("sem dados.instancia usa ativa do próprio usuário e preserva dados", async () => {
  const convo = conversation(); delete convo.dados.instancia;
  stage("start", "fim", { mensagem: "Olá" });
  await execute(); assert.equal(sends[0].path, "/message/sendText/instancia-1");
  assert.equal(convo.dados.instancia, "instancia-1"); assert.equal(convo.dados.custom, "preservar");
});

test("etapa de outra automação nunca executa", async () => {
  conversation(); stage("start", "mensagem", { texto: "Não enviar" }); tables.automacao_etapas[0].automacao_id = "outra";
  await assert.rejects(execute(), /Etapa atual/); assert.equal(sends.length, 0);
});

test("conversa finalizada ou sem etapa não envia", async () => {
  const convo = conversation(); convo.status = "finalizada";
  await execute(); convo.status = "ativa"; convo.etapa_atual_id = null;
  await execute(); assert.equal(sends.length, 0);
});

test("reentrega concorrente não duplica conversa nem execução", async () => {
  stage("start", "mensagem", { texto: "Olá" }); stage("end", "fim"); edge("start", "end");
  const responses = await Promise.all([POST(request("oi")), POST(request("oi"))]);
  assert.ok(responses.some(response => response.status === 200));
  assert.ok(responses.every(response => [200, 503].includes(response.status)));
  assert.equal(tables.whatsapp_conversas.length, 1); assert.equal(sends.length, 1);
  assert.equal(tables.whatsapp_mensagens.filter(row => row.direcao === "entrada").length, 1);
  assert.equal((await (await POST(request("oi"))).json()).duplicate, true);
});

test("conversa ocupada retorna 503 antes de registrar nova mensagem", async () => {
  const convo = conversation(); convo.execucao_token = "outro-token"; convo.execucao_ate = new Date(Date.now() + 60_000).toISOString();
  const response = await POST(request("oi"));
  assert.equal(response.status, 503); assert.equal(tables.whatsapp_mensagens.length, 0);
  assert.equal(convo.execucao_token, "outro-token");
});

test("falha na deduplicação não executa nem cria conversa", async () => {
  faults.db = (name, method) => name === "whatsapp_mensagens" && method === "GET";
  assert.equal((await POST(request("oi"))).status, 500);
  assert.equal(sends.length, 0); assert.equal(tables.whatsapp_conversas.length, 0);
});

test("webhook ignora fromMe, grupos e LID sem telefone; valida JSON e segredo", async () => {
  for (const key of [{ fromMe: true }, { remoteJid: "12345@g.us", remoteJidAlt: "5585999999999@s.whatsapp.net" }, { remoteJid: "123456789@lid" }]) {
    assert.equal((await (await POST(request("oi", "in-1", { key }))).json()).ignored, true);
  }
  const invalid = new Request("https://app.test", { method: "POST", headers: { "x-baueflow-secret": "webhook-secret" }, body: "{" });
  assert.equal((await POST(invalid)).status, 400);
  assert.equal((await POST(new Request("https://app.test", { method: "POST", body: "{}" }))).status, 401);
  assert.equal(sends.length, 0);
});

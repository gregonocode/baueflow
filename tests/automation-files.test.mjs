import assert from "node:assert/strict";
import { test } from "node:test";
import { handleAutomationFiles } from "../lib/automacoes/files.ts";
import { MAX_PDF_BYTES, sanitizedPdfName, validatePdf } from "../lib/automacoes/pdf.ts";

// Simula falhas independentes do banco e do Storage, além dos filtros de acesso.
function setup(faults = {}) {
  const tables = {
    automacoes: [{ id: "automation", user_id: "user" }],
    automacao_etapas: [{ id: "stage", automacao_id: "automation", tipo: "arquivo" }],
    automacao_arquivos: [],
  };
  const objects = new Map();
  const calls = [];
  const storage = {
    async upload(path, file) {
      calls.push("upload");
      if (faults.upload) return { error: {} };
      objects.set(path, file);
      return { error: null };
    },
    getPublicUrl: path => ({ data: { publicUrl: `https://storage.test/${path}` } }),
    async download(path) { return objects.has(path) ? { data: objects.get(path), error: null } : { error: {} }; },
    async remove(paths) {
      calls.push("remove");
      if (faults.remove) return { error: {} };
      paths.forEach(path => objects.delete(path));
      return { error: null };
    },
  };
  const db = {
    auth: { getUser: async () => ({ data: { user: faults.unauthenticated ? null : { id: "user" } }, error: null }) },
    storage: { from: name => { assert.equal(name, "whatsapp-assets"); return storage; } },
    from(name) {
      let action = "select", payload, single = false, order, limit;
      const filters = [];
      const query = {
        select() { return query; },
        eq(key, value) { filters.push(row => row[key] === value); return query; },
        order(key, options) { order = { key, ascending: options?.ascending !== false }; return query; },
        limit(value) { limit = value; return query; },
        maybeSingle() { single = true; return query; },
        single() { single = true; return query; },
        insert(value) { action = "insert"; payload = value; return query; },
        delete() { action = "delete"; return query; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            if (faults[action] && name === "automacao_arquivos") return { data: null, error: {} };
            let rows = tables[name].filter(row => filters.every(filter => filter(row)));
            if (action === "insert") {
              rows = [{ ...payload, id: crypto.randomUUID() }];
              tables[name].push(...rows);
            }
            if (action === "delete") tables[name] = tables[name].filter(row => !rows.includes(row));
            if (order) rows.sort((a, b) => (a[order.key] - b[order.key]) * (order.ascending ? 1 : -1));
            if (limit) rows = rows.slice(0, limit);
            return { data: single ? rows[0] ?? null : rows, error: null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  async function request(method, file, extra = "") {
    const body = file ? new FormData() : undefined;
    body?.append("file", file);
    return handleAutomationFiles(new Request(`https://app.test/api/automacoes/automation/arquivos?etapa_id=stage${extra}`, { method, body }), db, "automation");
  }
  return { request, tables, objects, calls };
}
const pdf = (name = "material.pdf", content = "%PDF-1.7\nconteúdo") => new File([content], name, { type: "application/pdf" });

test("PDF: valida MIME, extensão, conteúdo vazio e limite exato de 20 MB", () => {
  assert.equal(validatePdf({ name: "arquivo.PDF", type: "application/pdf", size: MAX_PDF_BYTES }), null);
  assert.ok(validatePdf({ name: "arquivo.pdf", type: "application/pdf", size: MAX_PDF_BYTES + 1 }));
  assert.ok(validatePdf({ name: "arquivo.exe", type: "application/pdf", size: 1 }));
  assert.ok(validatePdf({ name: "arquivo.pdf", type: "text/plain", size: 1 }));
  assert.ok(validatePdf({ name: "arquivo.pdf", type: "application/pdf", size: 0 }));
  assert.match(sanitizedPdfName("../../matemática ?#.PDF"), /^[a-zA-Z0-9_-]+\.pdf$/);
});

test("upload de múltiplos PDFs: ordem, nomes originais, URLs e paths sem colisão", async () => {
  const env = setup();
  for (let i = 1; i <= 3; i++) {
    const file = pdf("../matemática.pdf");
    const response = await env.request("POST", file);
    assert.equal(response.status, 201);
    const row = (await response.json()).file;
    assert.equal(row.ordem, i);
    assert.equal(row.nome, file.name);
    assert.equal(row.tamanho_bytes, file.size);
    assert.equal(row.mime_type, "application/pdf");
    assert.equal(row.tipo, "pdf");
    assert.match(row.storage_path, /^user\/automation\/stage\/[a-f0-9-]+-matematica.pdf$/);
    assert.equal(row.public_url, `https://storage.test/${row.storage_path}`);
  }
  assert.equal(env.objects.size, 3);
  assert.equal(env.tables.automacao_etapas[0].config, undefined);
  assert.equal((await (await env.request("GET")).json()).files.length, 3);
});

test("API rejeita sessão ausente, automação alheia e etapa de outra automação", async () => {
  const unauth = setup({ unauthenticated: true });
  assert.equal((await unauth.request("POST", pdf())).status, 401);
  const foreign = setup();
  foreign.tables.automacoes[0].user_id = "other";
  assert.equal((await foreign.request("POST", pdf())).status, 404);
  const wrongStage = setup();
  wrongStage.tables.automacao_etapas[0].automacao_id = "other";
  assert.equal((await wrongStage.request("POST", pdf())).status, 404);
  const wrongType = setup();
  wrongType.tables.automacao_etapas[0].tipo = "mensagem";
  assert.equal((await wrongType.request("POST", pdf())).status, 404);
  for (const env of [unauth, foreign, wrongStage, wrongType]) assert.equal(env.calls.length, 0);
});

test("API rejeita MIME, extensão, assinatura inválida e PDF maior que 20 MB", async () => {
  const env = setup();
  for (const file of [new File(["%PDF-"], "a.pdf", { type: "text/plain" }), pdf("a.exe"), pdf("a.pdf", "not a PDF"), new File([new Uint8Array(MAX_PDF_BYTES + 1)], "a.pdf", { type: "application/pdf" })]) {
    assert.equal((await env.request("POST", file)).status, 400);
  }
  assert.equal(env.objects.size, 0);
  assert.equal(env.tables.automacao_arquivos.length, 0);
});

test("falhas de upload e cadastro não deixam registros quebrados", async () => {
  for (const faults of [{ upload: true }, { insert: true }]) {
    const env = setup(faults);
    assert.equal((await env.request("POST", pdf())).status, 500);
    assert.equal(env.tables.automacao_arquivos.length, 0);
    assert.equal(env.objects.size, 0);
  }
});

test("remover PDF exclui objeto e registro; arquivos de outra etapa são protegidos", async () => {
  const env = setup();
  const file = (await (await env.request("POST", pdf())).json()).file;
  env.tables.automacao_arquivos[0].etapa_id = "other";
  assert.equal((await env.request("DELETE", null, `&arquivo_id=${file.id}`)).status, 404);
  assert.equal(env.objects.size, 1);
  env.tables.automacao_arquivos[0].etapa_id = "stage";
  assert.equal((await env.request("DELETE", null, `&arquivo_id=${file.id}`)).status, 200);
  assert.equal(env.objects.size, 0);
  assert.equal(env.tables.automacao_arquivos.length, 0);
});

test("falhas de remoção preservam o registro e o conteúdo do PDF", async () => {
  for (const faults of [{ remove: true }, { delete: true }]) {
    const env = setup(faults);
    const file = (await (await env.request("POST", pdf())).json()).file;
    assert.equal((await env.request("DELETE", null, `&arquivo_id=${file.id}`)).status, 500);
    assert.equal(env.tables.automacao_arquivos.length, 1);
    assert.equal(await env.objects.get(file.storage_path).text(), await pdf().text());
  }
});

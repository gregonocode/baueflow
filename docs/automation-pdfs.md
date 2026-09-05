# PDFs nas etapas de arquivo

Na criação, use **Salvar e adicionar PDFs**. A etapa é persistida e o modal
continua aberto com o seletor habilitado. Em etapas existentes, a lista é
carregada pela API ao abrir o modal. Uploads e remoções são imediatos;
nome e legenda são gravados por **Salvar etapa**. Fechar não desfaz uploads.

O navegador envia um PDF por requisição, sequencialmente, mesmo quando vários
arquivos são selecionados. A API usa a sessão do usuário e valida a automação,
a etapa, MIME, extensão, assinatura `%PDF-` e tamanho (até 20 × 1024 × 1024 bytes).
Cada objeto recebe UUID e nome sanitizado no caminho
`{user_id}/{automacao_id}/{etapa_id}/{uuid}-{nome}.pdf` do bucket `whatsapp-assets`.
O registro só é inserido depois do upload. Se o cadastro falhar, a API tenta
limpar o objeto; falhas nessa limpeza são registradas no servidor.

Os metadados ficam exclusivamente em `automacao_arquivos`. `ordem` começa em 1
e cada upload usa a maior ordem da etapa + 1. Remover não renumera os demais.
Envios simultâneos em abas distintas podem empatar na ordem; a sequência da
seleção múltipla dentro de um modal é preservada.

A remoção pede confirmação, busca o caminho no banco e exclui o objeto e o
registro. A API mantém uma cópia temporária em memória para restaurar o PDF
caso a exclusão do registro falhe. Banco e Storage não têm transação conjunta:
se a restauração também falhar, a API informa que a remoção ficou incompleta
e registra o identificador para recuperação operacional.

Não foi necessário alterar o schema nem o executor. A legenda é salva em
`config.caption`, já consumido pelo executor de arquivos.

## Configuração do Supabase

- Manter `whatsapp-assets` público para as URLs usadas pela Evolution.
- O limite global e o limite do bucket devem permitir pelo menos 20 MB.
- Se houver restrição de MIME no bucket, incluir `application/pdf`, preservando
  os outros tipos usados pela aplicação.
- Manter RLS em `automacao_arquivos`, com SELECT, INSERT e DELETE para o dono da
  automação; INSERT também deve verificar o vínculo da etapa com a automação.
- Em `storage.objects`, permitir INSERT, SELECT e DELETE para o usuário
  autenticado no seu diretório de `whatsapp-assets`.
- Usar as variáveis Supabase de URL e chave pública já existentes no projeto.
  Esta implementação não usa service role.

Referências: [políticas do Storage](https://supabase.com/docs/guides/storage/security/access-control)
e [limites de arquivos](https://supabase.com/docs/guides/storage/uploads/file-limits).

As políticas do ambiente remoto não foram inspecionadas nem alteradas. Se não
existirem políticas equivalentes, este SQL serve como configuração inicial.
Políticas permissivas existentes se combinam por OR; revisar as existentes
antes de adicionar regras. As tabelas `automacoes` e `automacao_etapas` devem
permitir ao usuário consultar seus próprios registros, como no editor atual.

```sql
alter table public.automacao_arquivos enable row level security;

create policy "automation_files_owner_select"
on public.automacao_arquivos for select to authenticated
using (exists (
  select 1 from public.automacoes a
  where a.id = automacao_arquivos.automacao_id and a.user_id = auth.uid()
));

create policy "automation_files_owner_insert"
on public.automacao_arquivos for insert to authenticated
with check (exists (
  select 1 from public.automacoes a
  join public.automacao_etapas e on e.automacao_id = a.id
  where a.id = automacao_arquivos.automacao_id
    and e.id = automacao_arquivos.etapa_id and e.tipo = 'arquivo'
    and a.user_id = auth.uid()
));

create policy "automation_files_owner_delete"
on public.automacao_arquivos for delete to authenticated
using (exists (
  select 1 from public.automacoes a
  where a.id = automacao_arquivos.automacao_id and a.user_id = auth.uid()
));

create policy "automation_pdf_storage_insert"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'whatsapp-assets'
  and (storage.foldername(name))[1] = auth.uid()::text
  and lower(storage.extension(name)) = 'pdf'
  and exists (
    select 1 from public.automacoes a
    join public.automacao_etapas e on e.automacao_id = a.id
    where a.id::text = (storage.foldername(name))[2]
      and e.id::text = (storage.foldername(name))[3]
      and a.user_id = auth.uid() and e.tipo = 'arquivo'
  )
);

create policy "automation_pdf_storage_select"
on storage.objects for select to authenticated
using (
  bucket_id = 'whatsapp-assets'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "automation_pdf_storage_delete"
on storage.objects for delete to authenticated
using (
  bucket_id = 'whatsapp-assets'
  and (storage.foldername(name))[1] = auth.uid()::text
);
```

## Hospedagem e validação

O servidor/reverse proxy deve aceitar requisições multipart de pelo menos
21 MB (PDF de 20 MB mais metadados). O proxy Next atual só intercepta
`/dashboard`, não a API de upload. Nenhuma mudança em `next.config.ts` foi necessária.

Testes locais:

```sh
npx tsc --noEmit
node --import ./tests/register.mjs --test --test-isolation=none tests/*.test.mjs
```

Os testes de PDFs simulam banco e Storage. Antes de publicar, verificar com
sessão real: criar uma etapa, enviar dois PDFs, reabrir, remover um e confirmar
os objetos/linhas no Supabase. Testar também PDF de 20 MB no ambiente hospedado.

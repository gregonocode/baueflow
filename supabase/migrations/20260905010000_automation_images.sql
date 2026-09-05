-- Habilita imagem sem substituir as listas de tipos já usadas pelo projeto.
-- O schema inicial é gerenciado no Supabase: suporta tipo text com CHECK ou enum.
do $$
declare
  column_info record;
  type_check record;
begin
  for column_info in
    select c.oid as table_oid, c.relname as table_name, a.attnum,
      t.typtype, t.typname, n.nspname as type_schema
    from pg_class c
    join pg_attribute a on a.attrelid = c.oid
    join pg_type t on t.oid = a.atttypid
    join pg_namespace n on n.oid = t.typnamespace
    where c.relnamespace = 'public'::regnamespace
      and c.relname in ('automacao_etapas', 'automacao_arquivos', 'whatsapp_mensagens')
      and a.attname = 'tipo' and not a.attisdropped
  loop
    if column_info.typtype = 'e' then
      execute format('alter type %I.%I add value if not exists %L',
        column_info.type_schema, column_info.typname, 'imagem');
    end if;
    -- Só amplia CHECKs da coluna tipo. Restrições de outras colunas são preservadas.
    for type_check in
      select conname, convalidated, pg_get_expr(conbin, conrelid) as expression
      from pg_constraint
      where conrelid = column_info.table_oid and contype = 'c'
        and conkey = array[column_info.attnum]::smallint[]
    loop
      execute format('alter table public.%I drop constraint %I', column_info.table_name, type_check.conname);
      execute format('alter table public.%I add constraint %I check ((%s) or tipo::text = %L) not valid',
        column_info.table_name, type_check.conname, type_check.expression, 'imagem');
      if type_check.convalidated then
        execute format('alter table public.%I validate constraint %I', column_info.table_name, type_check.conname);
      end if;
    end loop;
  end loop;
end;
$$;

-- Acrescenta permissões apenas para imagens. As políticas de PDFs permanecem.
-- Usa casts para text para também suportar enums ampliados nesta transação.
create policy "automation_images_owner_select"
on public.automacao_arquivos for select to authenticated
using (tipo::text = 'imagem' and exists (
  select 1 from public.automacoes a
  where a.id = automacao_arquivos.automacao_id and a.user_id = auth.uid()
));

create policy "automation_images_owner_insert"
on public.automacao_arquivos for insert to authenticated
with check (
  tipo::text = 'imagem'
  and mime_type in ('image/png', 'image/jpeg', 'image/webp')
  and tamanho_bytes > 0 and tamanho_bytes <= 10485760
  and exists (
    select 1 from public.automacoes a
    join public.automacao_etapas e on e.automacao_id = a.id
    where a.id = automacao_arquivos.automacao_id
      and e.id = automacao_arquivos.etapa_id and e.tipo::text = 'imagem'
      and a.user_id = auth.uid()
  )
);

create policy "automation_images_owner_delete"
on public.automacao_arquivos for delete to authenticated
using (tipo::text = 'imagem' and exists (
  select 1 from public.automacoes a
  where a.id = automacao_arquivos.automacao_id and a.user_id = auth.uid()
));

create policy "automation_images_storage_insert"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'whatsapp-assets'
  and (storage.foldername(name))[1] = auth.uid()::text
  and lower(storage.extension(name)) in ('png', 'jpg', 'jpeg', 'webp')
  and exists (
    select 1 from public.automacoes a
    join public.automacao_etapas e on e.automacao_id = a.id
    where a.id::text = (storage.foldername(name))[2]
      and e.id::text = (storage.foldername(name))[3]
      and a.user_id = auth.uid() and e.tipo::text = 'imagem'
  )
);

create policy "automation_images_storage_select"
on storage.objects for select to authenticated
using (
  bucket_id = 'whatsapp-assets'
  and (storage.foldername(name))[1] = auth.uid()::text
  and lower(storage.extension(name)) in ('png', 'jpg', 'jpeg', 'webp')
);

create policy "automation_images_storage_delete"
on storage.objects for delete to authenticated
using (
  bucket_id = 'whatsapp-assets'
  and (storage.foldername(name))[1] = auth.uid()::text
  and lower(storage.extension(name)) in ('png', 'jpg', 'jpeg', 'webp')
);

-- Aplicar antes de publicar o executor. Não apaga/mescla dados existentes.
-- Se houver duplicatas históricas, os índices falham para permitir revisão manual.
alter table public.whatsapp_conversas
  add column if not exists execucao_token uuid,
  add column if not exists execucao_ate timestamptz;

create unique index if not exists whatsapp_mensagens_incoming_external_instance
  on public.whatsapp_mensagens (external_message_id, (coalesce(payload->>'instance', '')))
  where direcao = 'entrada' and external_message_id is not null;

create unique index if not exists whatsapp_conversas_one_active_contact_instance
  on public.whatsapp_conversas (user_id, telefone, (coalesce(dados->>'instancia', '')))
  where status = 'ativa';

comment on column public.whatsapp_conversas.execucao_token is
  'Lease do executor; impede dois webhooks de executarem a mesma conversa simultaneamente.';

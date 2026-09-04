alter table public.automacoes
  add column if not exists iniciar_novas_conversas boolean not null default false;

comment on column public.automacoes.iniciar_novas_conversas is
  'Inicia esta automação quando um contato sem conversa ativa envia qualquer primeira mensagem.';

create unique index if not exists automacoes_one_default_entry_per_user
  on public.automacoes (user_id)
  where iniciar_novas_conversas = true and status = 'ativa';

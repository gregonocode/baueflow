# Motor de automações

O webhook registra a entrada e chama `lib/automacoes/executor.ts`. O motor usa
service role, valida o usuário dono da automação e percorre até 30 etapas por
chamada. `lib/evolution.ts` só pode ser importado no backend.

## Preparação

1. Aplicar `supabase/migrations/20260904190000_add_automation_entry_mode.sql`, se
   ainda não aplicada, e `supabase/migrations/20260904210000_automation_execution.sql`.
   A segunda adiciona o bloqueio temporário por conversa e índices únicos para
   entradas e conversas ativas. Não remove duplicatas históricas: se um índice
   falhar, revisar esses registros antes de repetir a migration.
2. Configurar no servidor `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`,
   `EVOLUTION_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` e
   `NEXT_PUBLIC_SUPABASE_URL` (também aceita `SUPABASE_URL_PUBLIC`/`SUPABASE_URL`).
3. Cadastrar a instância em `whatsapp_instancias`, vinculada ao `user_id` dono da
   automação. O webhook resolve o dono por `instance_name` e não precisa mais de
   `BAUEFLOW_OWNER_USER_ID`. `EVOLUTION_INSTANCE` é um filtro opcional do webhook;
   omitir esse filtro para receber várias instâncias.
4. Confirmar o campo de atividade no schema real: o código usa
   `whatsapp_instancias.status = 'ativa'`. Esse schema não foi fornecido no repo.
   A instância de `dados.instancia`, quando presente, deve pertencer ao mesmo
   usuário e estar ativa. Não há fallback para outro nome nesse caso.
5. Na Evolution, apontar `MESSAGES_UPSERT` para
   `/api/evolution/webhook` com o header `x-baueflow-secret`. Configurar reentrega
   de respostas `503`, usadas quando outra mensagem está executando a conversa.

O código foi conferido contra o [DTO da tag 2.3.7](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/dto/sendMessage.dto.ts)
e o [schema de mensagens dessa tag](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/validate/message.schema.ts).
Texto usa `{ number, text }`. Mídia usa `{ number, mediatype, media, fileName?, caption? }`.
O campo `media` recebe diretamente a URL pública do arquivo. Não há download local.

## Comportamento

| Tipo | Ação |
| --- | --- |
| mensagem | Envia `config.texto`, registra saída e segue `default`. |
| video | Envia `config.url` com legenda opcional e segue `default`. |
| arquivo | Busca arquivos pelo ID da automação e etapa, ordena por `ordem`, envia cada um e segue `default`. Aceita `pdf`, `documento`, `document` e `video`. |
| opcoes | Envia pergunta/menu numerado e para em `aguardando_opcao`. Aceita número, ID exato ou label completo sem distinguir maiúsculas. |
| capturar_email | Pede e-mail e para em `aguardando_email`. Valida formato simples; `validar: false` desliga a regex conforme a opção do editor. |
| acao_api | Substitui variáveis em body/headers recursivamente e faz POST/PUT/PATCH com timeout de 15 segundos. Não segue redirects. |
| pix | Envia a mensagem com botão “Copiar Pix” quando `codigo_pix` está preenchido e segue `default` sem esperar pagamento. Sem código, envia somente `mensagem`. |
| espera | Aguarda até 10 segundos e segue. Esperas maiores pausam a conversa. |
| fim | Envia mensagem opcional, finaliza a conversa e limpa a etapa atual. |

`{{nome}}`, `{{telefone}}` e `{{email}}` usam os dados da conversa; valores ausentes
viram texto vazio. Dados adicionais em `dados` são preservados. A primeira
mensagem apenas inicia o fluxo. Uma resposta só pode ser consumida pela etapa que
já estava aguardando quando o executor foi chamado.

Saídas só recebem `status = 'enviada'` depois de uma resposta 2xx da Evolution;
o ID retornado em `key.id` é salvo quando disponível. `enviada` indica que a API
aceitou o envio, não confirmação de leitura ou entrega ao dispositivo.

## Erros, concorrência e retomada

A deduplicação consulta o ID externo e a instância antes do motor. O índice único
é a garantia adicional contra entradas simultâneas. Um lease de 120 segundos,
renovado antes das etapas e envios, impede execução concorrente da conversa.
Se ocupado, o webhook retorna `503` antes de salvar a nova entrada.

Falhas de envio, banco, API ou configuração marcam `dados.estado = 'erro'` e
preservam a etapa. Sem conexão e espera longa usam `pausada`,
com `motivo_pausa`. Novas mensagens não reiniciam automaticamente esses estados.
O limite de 30 etapas também termina em erro para evitar ciclos infinitos.

## Pix por confiança

No editor, preencher `mensagem`, o título opcional (`descricao`), a chave ou código
do banco (`codigo_pix`) e, se desejar, `texto_botao` (padrão “Copiar Pix”). O envio
usa `/message/sendButtons/{instance}` com um botão
`{ type: 'copy', displayText: 'Copiar Pix', copyCode: codigo_pix }`, implementado
como `cta_copy` no [Baileys da Evolution 2.3.7](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts#L2998).

O conteúdo também aparece no texto para cópia manual. `valor_centavos` só informa
o valor na mensagem; não gera nem altera o código bancário. Não há gateway,
confirmação de pagamento ou espera pelo clique. Posicionar o Pix depois da entrega
do produto e conectar sua saída `default` à próxima etapa ou ao fim.

Os envios usam o mesmo comportamento em desenvolvimento e produção. Validar a
exibição do botão em um WhatsApp real; os testes simulam a resposta HTTP da API.

Não há transação distribuída entre WhatsApp e Postgres: uma queda após envio e
antes da gravação pode deixar o envio sem registro. A mesma entrada não é
reexecutada automaticamente, mesmo que a execução tenha falhado. Antes de
retomar manualmente, conferir os envios reais, corrigir o fluxo e definir a etapa
correta e `dados.estado = 'executando'`, preservando os demais dados. Uma nova
mensagem poderá então disparar a execução. Não basta reenviar o mesmo webhook.
Uma execução interrompida abruptamente pode deixar um lease até sua expiração.

O processamento é síncrono dentro da requisição. Os timeouts individuais não
garantem que a soma de 30 etapas caiba na duração da função da hospedagem: manter
sequências pequenas e verificar o limite configurado. Fila, agendamento,
retomada automática e garantia de entrega após falhas ficam para outra etapa.

## Verificação

`npm test` usa Node 24 e simula HTTP do Supabase, da Evolution e da ação API.
Não usa credenciais reais e não envia mensagens. No sandbox que bloqueia criação
de processos, rodar:

```sh
node --import ./tests/register.mjs --test --test-isolation=none tests/automation.test.mjs
```

Validar também `npm run build`. Após aplicar a migration e confirmar o schema real,
testar com um contato controlado: primeira mensagem → pergunta → `2` → arquivos
→ e-mail inválido → e-mail válido → ação API → fim. Conferir saídas e IDs no banco
e repetir a mesma entrega para verificar que nada é reenviado.

O botão “Adicionar arquivo” do dashboard ainda não cadastra arquivos. O executor
envia os registros já presentes em `automacao_arquivos`; o upload pelo editor é
uma implementação separada.

# Etapa imagem

## Editor e upload

Selecione **imagem**, informe nome e legenda opcional, e clique em
**Salvar e adicionar imagens**. A etapa é criada (incluindo a ligação automática
com a anterior) e o modal permanece aberto. Use **Selecionar imagem** para
enviar um ou vários PNG, JPEG ou WebP de até 10 MB cada. Os envios são sequenciais
e a interface mostra andamento, sucesso e erro. Falhas mantêm o modal aberto.

O gerenciador `media-files.tsx` é compartilhado com os PDFs, que continuam com
limite de 20 MB e sua própria validação. Uma etapa de imagem aceita somente
imagens; uma etapa arquivo aceita somente PDFs no upload.

A API existente `/api/automacoes/[id]/arquivos?etapa_id=...` valida autenticação,
dono da automação, vínculo/tipo da etapa, MIME, extensão, tamanho e assinatura
do formato. Usa a sessão do usuário, sem service role. O objeto recebe caminho
`{user_id}/{automacao_id}/{etapa_id}/{uuid}-{nome-sanitizado}` no bucket público
`whatsapp-assets`.

Após upload, grava em `automacao_arquivos`: IDs da automação e etapa, nome original,
`tipo: "imagem"`, `storage_path`, `public_url`, MIME original, tamanho em bytes e
`ordem` (maior ordem atual + 1). O conteúdo não é salvo em config;
`config.caption` guarda apenas a legenda.

Ao reabrir o modal, os registros são buscados novamente. Remover pede confirmação,
exclui o objeto e o registro e atualiza a lista. A recuperação de falhas é a mesma
dos PDFs: limpar upload sem registro e tentar restaurar o objeto se a exclusão
do registro falhar. Operações entre banco e Storage não são transacionais.
Uploads de abas simultâneas podem empatar na ordem, como no fluxo de PDFs.

## Executor e Evolution

O executor busca os registros por `etapa_id` e `automacao_id`, ordenados por
`ordem`. Verifica que há imagens válidas, envia cada URL com `mediatype: "image"`
e legenda somente na primeira (com substituição de variáveis). Cada envio bem
sucedido gera uma linha `whatsapp_mensagens` com `tipo: "imagem"`, status,
ID externo e URL no payload. Depois segue a conexão `default`.

Ausência de imagens, mídia inválida, falha de consulta ou envio interrompe a
execução, mantém a etapa atual e registra `dados.estado: "erro"` e o motivo.
Como nos arquivos, uma falha depois de envios parciais exige atenção ao retomar:
imagens já enviadas podem ser reenviadas na retomada manual.

O payload plano foi conferido no [DTO da Evolution 2.3.7](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/dto/sendMessage.dto.ts)
e no [schema de mensagens](https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/validate/message.schema.ts),
versão referenciada pela lib existente. Endpoint: `POST /message/sendMedia/{instance}`;
campos: `number`, `mediatype`, `media` e `caption` quando preenchida.

## Supabase

Aplicar `supabase/migrations/20260905010000_automation_images.sql` antes de usar:

- Acrescenta `imagem` aos enums e CHECKs exclusivos da coluna `tipo`, quando
  existentes, em etapas, arquivos e mensagens, preservando os tipos antigos.
- Adiciona políticas para imagens em `automacao_arquivos` e `storage.objects`,
  sem substituir as políticas dos PDFs.
- Não cria tabela nem bucket. Não muda o estado de RLS das tabelas existentes.

O schema inicial não está versionado neste repositório. A migration cobre colunas
text com CHECKs simples e enums; restrições compostas ou domains personalizados
devem ser conferidos no projeto real. A migration foi criada localmente; não foi
aplicada nem testada contra o banco remoto. Conferir RLS habilitado e as políticas
existentes de acesso do proprietário; políticas permissivas se combinam por OR.

Manter `whatsapp-assets` público. Se houver lista de MIME permitidos no bucket,
incluir `image/png`, `image/jpeg`, `image/webp` preservando `application/pdf` e
os demais tipos usados. Manter limite do bucket/global de pelo menos 20 MB para
não reduzir o suporte aos PDFs. A API limita imagens a 10 MB.

## Teste manual

1. No dashboard, crie **Mensagem → Imagem → Fim**. Salve a etapa imagem e envie
   dois arquivos, de preferência um JPEG e um PNG. Adicione uma legenda com
   `{{nome}}`, salve e confira o card com “2 imagens configuradas”.
2. Reabra o modal, confira a lista e remova uma imagem com confirmação. Reenvie
   a imagem e confira persistência, ordem e os objetos no Storage.
3. Tente enviar um SVG, um arquivo renomeado indevidamente e uma imagem maior
   que 10 MB. Deve haver erro, sem registro novo e sem fechar o modal.
4. Ative a automação com um gatilho e use um contato/conversa nova para acioná-la
   no WhatsApp. Confira texto, imagens em ordem, legenda na primeira e finalização.
5. Repita com **Imagem → Mensagem → Fim**. A primeira etapa deve ficar inicial
   automaticamente e a mensagem seguinte deve chegar após as imagens.
6. Em uma automação de teste, deixe a etapa imagem sem arquivos. A execução deve
   permanecer nela com estado de erro, sem enviar a etapa seguinte.

Os testes automatizados simulam Storage e Evolution; não enviam mensagens reais.

# Arquitetura e decisões

Este documento explica **por que** o sistema é como é: as garantias que ele oferece, onde cada garantia é aplicada, as alternativas descartadas e o que ficou de fora. Setup e comandos estão no [README.md](./README.md).

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Organização do código (DDD, camadas, SOLID)](#2-organização-do-código)
3. [Dinheiro](#3-dinheiro)
4. [Modelo de domínio e máquina de estados](#4-modelo-de-domínio-e-máquina-de-estados)
5. [Regras de negócio e interpretações adotadas](#5-regras-de-negócio-e-interpretações-adotadas)
6. [Persistência, MikroORM e estratégia transacional](#6-persistência-mikroorm-e-estratégia-transacional)
7. [Concorrência](#7-concorrência)
8. [Idempotência](#8-idempotência)
9. [API HTTP e contrato de erros](#9-api-http-e-contrato-de-erros)
10. [Mensageria: consumidor SQS, inbox e DLQ](#10-mensageria-consumidor-sqs-inbox-e-dlq)
11. [Transactional Outbox](#11-transactional-outbox)
12. [Referências fora de ordem](#12-referências-fora-de-ordem)
13. [Observabilidade](#13-observabilidade)
14. [Teste de carga](#14-teste-de-carga)
15. [Autenticação](#15-autenticação)
16. [Estratégia de testes](#16-estratégia-de-testes)
17. [Lições aprendidas durante o desenvolvimento](#17-lições-aprendidas-durante-o-desenvolvimento)
18. [Limitações e próximos passos](#18-limitações-e-próximos-passos)

---

## 1. Visão geral

```
                 HTTP (Idempotency-Key)                     SQS wager-transactions.fifo
                          │                                            │
                          ▼                                            ▼
                 WagerTransactionsController            WagerTransactionMessageHandler
                          │                                            │
                          └──────────────► ProcessWagerTransaction ◄───┘   (mesmo caso de uso)
                                                    │
                     ┌──────────────── 1 transação PostgreSQL ────────────────┐
                     │  SELECT … FOR UPDATE na wallet                          │
                     │  wager_transactions · wallets · wallet_ledger_entries   │
                     │  inbox_messages (se veio da fila) · outbox_messages     │
                     └──────────────────────────────────────────────────────────┘
                                │                               │
                    OutboxRelay (N instâncias)        PendingReferenceSweeper (N instâncias)
                                │                               │
                                ▼                               ▼
                    SQS wagering-events.fifo         SettlePendingReference
```

Princípios que guiam todas as decisões:

- **O banco é a fonte da verdade e a última linha de defesa.** Unicidade, imutabilidade do ledger, não-negatividade e consistência saldo ↔ ledger são aplicadas por constraints e triggers no PostgreSQL. O código de aplicação as respeita, mas não é o único guardião.
- **Um caso de uso, dois canais.** HTTP e SQS chamam o mesmo `ProcessWagerTransaction`; o canal só traduz entrada e saída.
- **Tudo que é efeito financeiro acontece numa única transação SQL.** Transação, saldo, ledger, inbox e evento de integração são confirmados juntos ou nenhum é.
- **Entrega at-least-once, efeito exactly-once.** Mensagens e eventos podem repetir; o efeito financeiro não, porque a deduplicação é persistente e garantida por unique constraints.
- **Uma só fonte de tempo para agendamento.** Comparações de "já está na hora?" usam `now()` do PostgreSQL (ver [§17](#17-lições-aprendidas-durante-o-desenvolvimento)).

## 2. Organização do código

### Bounded contexts

| Contexto | Responsabilidade |
|---|---|
| `wagering` | wallets, transações de aposta, ledger, reversões, reconciliação |
| `messaging` | inbox, outbox, consumidor genérico de fila, publisher SQS |
| `shared` | kernel compartilhado: `Money`, erros base, `IntegrationEvent`, `UnitOfWork`, `Clock`, observabilidade |

`messaging` não conhece regras de aposta: o `QueueConsumer` fala com uma porta `MessageQueue` e entrega mensagens a um `MessageHandler`. Quem traduz uma mensagem em um caso de uso é o handler na camada de apresentação de `wagering`, exatamente como um controller faz para HTTP.

### Camadas

```
presentation  →  application  →  domain
      ↘               ↓
       infrastructure (implementa as portas)
```

- **domain**: agregados `Wallet` e `WagerTransaction`, entidade imutável `WalletLedgerEntry`, value object `Money`, serviço de domínio `WagerSettlementService`, especificação `ReferencePolicy`, eventos de integração. Sem NestJS, sem MikroORM, sem I/O.
- **application**: casos de uso (`OpenWallet`, `ProcessWagerTransaction`, `SettlePendingReference`, `ReconcileWallet`), workers (`PendingReferenceSweeper`, `OutboxRelay`, `QueueConsumer`) e portas (`WagerTransactionRepository`, `OutboxStore`, `EventPublisher`, `MessageQueue`, `PendingReferenceQueue`, `DiagnosticContext`).
- **infrastructure**: adaptadores MikroORM e SQL, SQS, telemetria Prometheus, composição.
- **presentation**: controllers HTTP, presenters e o handler da fila.

### Aplicação de SOLID e DRY

- **SRP**: o `SettlementRecorder` só persiste o resultado de uma liquidação; o `ReferenceResolver` só resolve referências; o `WagerSettlementService` só decide o resultado.
- **OCP / DIP**: workers e casos de uso dependem de portas; telemetria entra por observers (`WagerProcessingObserver`, `UnitOfWorkObserver`, `QueueConsumerObserver`, `OutboxRelayObserver`). Trocar Prometheus por OpenTelemetry não toca a camada de aplicação.
- **ISP**: portas pequenas (o `PendingReferenceQueue` tem dois métodos).
- **DRY**: `UnitOfWork<R>` genérico com política de retry declarativa; `PollingLoop` compartilhado pela outbox e pelo worker de referências; `fingerprint` (JSON canônico + SHA-256) usado pela idempotência HTTP e pela inbox; `sampledGauge` para todas as métricas lidas do banco.

### Composição

`composeWagering()` (`wagering/infrastructure/wagering.composition.ts`) é o composition root do contexto: monta repositórios, unidade de trabalho e casos de uso a partir de dependências explícitas. O módulo Nest só chama essa função. Assim, os testes de integração montam a aplicação real sem subir o Nest, e os casos de uso não dependem do container de injeção.

### E CQRS?

Há uma separação leve de leitura e escrita: comandos passam por casos de uso e agregados com lock; consultas (`GET /wallets/:id`, ledger paginado, transações) usam read models (`WalletReadModel`, `TransactionReadModel`) que leem direto das tabelas, sem reidratar agregados nem pegar lock. Não há modelo de leitura separado nem projeções assíncronas: o volume de leitura do desafio não justifica a consistência eventual que isso traria para o saldo.

## 3. Dinheiro

- **No domínio**: `Money` guarda o valor como `bigint` em unidades mínimas (centavos) e a moeda ISO-4217. Toda operação devolve uma nova instância; operações entre moedas diferentes lançam `CurrencyMismatchError`.
- **Por que `bigint` e não `decimal.js`**: com escala fixa de 2 casas, a soma e a subtração em inteiros são exatas e não há divisão nem arredondamento no domínio. `bigint` é nativo, não tem dependência e não permite misturar acidentalmente com `number` (o TypeScript recusa `bigint + number`). Uma biblioteca decimal faria sentido se houvesse câmbio, juros ou rateio.
- **Validação da entrada** (`Money.from`): aceita apenas `^(0|[1-9]\d{0,16})\.\d{2}$`, ou seja, **escala fixa de exatamente 2 casas** na entrada e na saída. Rejeita string vazia, `NaN`, `Infinity`, notação científica, sinal, zeros à esquerda, `"25"`, `"25.5"` e mais de 2 casas. Valores negativos não existem no contrato de entrada. `money` aceita somente `amount` e `currency`.
- **Por que exigir as 2 casas na entrada**: o formato do valor é parte do contrato financeiro. Aceitar `"25"` obrigaria a normalizar antes do hash de idempotência e abriria espaço para dois provedores interpretarem o mesmo campo de formas diferentes. Com a escala fixa, a string recebida é a mesma que é persistida, publicada e usada no hash.
- **Serialização**: sempre string com 2 casas (`"25.00"`).
- **Persistência**: `numeric(19,2)` no PostgreSQL, mapeado por um tipo customizado (`NumericStringType`) que troca strings com o driver. O valor nunca passa por `number` em nenhuma camada.
- **Multi-moeda**: o modelo é multi-moeda (wallet tem moeda; FKs compostas garantem que ledger e transação usam a moeda da wallet). Os cenários usam BRL; conflitos de moeda são testados.

## 4. Modelo de domínio e máquina de estados

Todas as classes de domínio têm construtor privado e factories estáticas: `create`/`open`/`receive`/`enqueue` validam regras; `rehydrate` reconstrói estado persistido sem revalidar transições.

### Wallet (aggregate root)

- `debit` e `credit` alteram saldo, incrementam `version` e criam o `WalletLedgerEntry` correspondente **no mesmo método**: não existe caminho que mude saldo sem lançamento.
- `version` começa em 1 e só incrementa quando o saldo muda; cada lançamento registra a `wallet_version` resultante.
- O repositório salva a wallet e os lançamentos pendentes juntos.

### WalletLedgerEntry

Imutável estruturalmente (campos `readonly`, sem métodos de transição). A factory valida `balanceBefore ± money === balanceAfter`. No banco, triggers impedem `UPDATE`, `DELETE` e `TRUNCATE`.

### WagerTransaction

```
                ┌──────────────► PROCESSED   (terminal)
                │
   PENDING ─────┼──────────────► REJECTED    (terminal)
   (em memória) │
                └──► PENDING_REFERENCE ──┬──► PROCESSED
                          ▲   │          ├──► REJECTED (inclusive REFERENCE_NOT_FOUND)
                          └───┘          
                     reagendamento
```

- A transação nasce `PENDING` dentro do caso de uso e, na mesma transação SQL, vai para `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`.
- `PROCESSED`, `REJECTED` e `FAILED` são terminais. Tentar transicionar uma transação terminal lança `InvalidStateTransitionError`, tratado como erro de programação (HTTP 500), não como caminho de negócio.
- O trigger `wager_tx_guard` repete a regra no banco: campos de negócio são imutáveis, estado terminal não muda, ninguém volta para `PENDING`.
- `OPENING` é interno: só `OpenWallet` cria; a API e a fila aceitam apenas `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.

## 5. Regras de negócio e interpretações adotadas

| Operação | Efeito no saldo | Ledger | Referência |
|---|---|---|---|
| BET | débito | 1 DEBIT | não aceita |
| WIN | crédito | 1 CREDIT | opcional; se informada, deve ser uma BET |
| LOSS | nenhum | nenhum | opcional; se informada, deve ser uma BET |
| REFUND | crédito | 1 CREDIT | obrigatória; só BET |
| ROLLBACK | inverso da referência | 1 lançamento invertido | obrigatória; BET, WIN ou REFUND |

Regras comuns a toda referência (`ReferencePolicy`): deve estar `PROCESSED` e pertencer ao mesmo provider, player, wallet, moeda e rodada. Reversões (REFUND e ROLLBACK) exigem valor igual ao da referência.

Interpretações documentadas:

1. **Reversão única por referência, qualquer que seja o tipo.** O enunciado diz "não pode ser revertida duas vezes pelo mesmo tipo de operação". A implementação adota a leitura mais estrita: uma BET revertida por REFUND não pode ser revertida também por ROLLBACK, e vice-versa, porque as duas operações devolveriam o mesmo dinheiro duas vezes. O índice parcial único `uq_wager_tx_single_reversal` garante isso no banco. Reverter uma reversão (ROLLBACK de um REFUND) é permitido, porque referencia outra transação.
2. **ROLLBACK que deixaria saldo negativo** (por exemplo, desfazer um WIN já gasto) é rejeitado com `REVERSAL_WOULD_OVERDRAW`, distinto do `INSUFFICIENT_FUNDS` de uma aposta: o primeiro exige tratamento operacional, o segundo é comportamento normal do jogador.
3. **WIN e LOSS sem referência são aceitos**, porque o enunciado diz que WIN "pode" referenciar a BET. Quando informada, a referência é validada como as demais.
4. **Replay devolve o resultado original**, inclusive o `balance` observado naquele momento (persistido em `balance_after`).

### Taxonomia de `failureCode`

Cada rejeição carrega um código estável e uma ação sugerida (`providerAction`) devolvida na resposta, para o provedor decidir sem interpretar mensagens:

| failureCode | Quando | providerAction |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | `do-not-retry` |
| `REVERSAL_WOULD_OVERDRAW` | ROLLBACK de crédito deixaria saldo negativo | `do-not-retry` |
| `CURRENCY_MISMATCH` | moeda da operação ≠ moeda da wallet | `fix-and-resend` |
| `WALLET_PLAYER_MISMATCH` | a wallet não pertence ao `playerId` | `fix-and-resend` |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do prazo de espera | `do-not-retry` |
| `REFERENCE_NOT_PROCESSED` | referência existe mas foi rejeitada | `do-not-retry` |
| `REFERENCE_MISMATCH` | referência de outro player, wallet, moeda ou rodada | `fix-and-resend` |
| `INVALID_REFERENCE_KIND` | tipo de referência não permitido | `fix-and-resend` |
| `REVERSAL_AMOUNT_MISMATCH` | valor da reversão ≠ valor da referência | `fix-and-resend` |
| `ALREADY_REVERSED` | referência já revertida | `do-not-retry` |
| `PROCESSING_FAILED` | reservado para erro permanente registrado como `FAILED` | `do-not-retry` |

`fix-and-resend` significa reenviar com **outro** `externalTransactionId` e outra `Idempotency-Key`, já que a rejeição original fica registrada e o replay da mesma chave devolve a mesma rejeição.

## 6. Persistência, MikroORM e estratégia transacional

### Por que MikroORM

É a opção preferencial do desafio e tem o que o problema pede: Unit of Work e Identity Map explícitos, `em.transactional()`, `LockMode.PESSIMISTIC_WRITE` e `EntitySchema` para mapear sem decorators. O mapeamento fica em `infrastructure/persistence/*.record.ts` com mappers explícitos para o domínio. Assim o domínio não conhece o ORM, e o modelo de persistência pode ter colunas que o domínio não expõe (por exemplo `updated_at`).

Onde o ORM atrapalharia, o acesso é feito com SQL direto pela mesma conexão: claim da outbox e do worker de referências (`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`), reconciliação e o "expedite" de pendências.

### Unidade de trabalho

`MikroOrmUnitOfWork<R>` executa cada caso de uso em `em.fork({ clear: true }).transactional(...)`:

1. `SET LOCAL lock_timeout` limita a espera por lock (padrão 5 s).
2. Os repositórios recebem o `EntityManager` da transação.
3. Violações de unique constraints sabidamente disputadas por escritores concorrentes (`uq_wager_tx_idempotency_key`, `uq_wager_tx_provider_external`, `pk_inbox_messages`) fazem a transação inteira ser repetida. Na repetição, o caso de uso encontra a linha vencedora e devolve replay.
4. Falhas transitórias (deadlock, serialização, lock timeout, conexão) são repetidas com backoff, até `TRANSACTION_MAX_ATTEMPTS`. Esgotadas, viram `TransientInfrastructureError` (HTTP 503 com `Retry-After`, ou retry na fila).

### Schema: garantias aplicadas pelo banco

| Garantia | Mecanismo |
|---|---|
| Uma wallet por player e moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` na wallet, `CHECK` em `balance_before`, `balance_after` e `balance_after` da transação |
| Idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| No máximo um lançamento por transação e wallet | `UNIQUE (transaction_id, wallet_id)` |
| Aritmética do lançamento | `CHECK` de `balance_before ± amount = balance_after` |
| Ledger append-only | triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` |
| Cadeia do ledger sem buracos | `UNIQUE (wallet_id, wallet_version)` e trigger `ledger_chain` (versão anterior + 1, `balance_before` igual ao `balance_after` anterior) |
| Saldo materializado = último lançamento | constraint trigger diferido `wallet_matches_ledger`, checado no `COMMIT` |
| Transação processada ↔ lançamento | constraint triggers diferidos `ledger_matches_transaction` e `transaction_matches_ledger` |
| Moeda coerente entre wallet, transação e ledger | FKs compostas `(id, currency)` e `(transaction_id, wallet_id, currency)` |
| Reversão única | índice parcial único `uq_wager_tx_single_reversal` |
| Máquina de estados | trigger `wager_tx_guard` |
| Inbox | `PRIMARY KEY (consumer_name, message_id)` |
| Evento imutável | trigger `outbox_guard` (conteúdo e `published_at` não mudam depois de gravados) |

As FKs entre transação, wallet e ledger são `DEFERRABLE INITIALLY DEFERRED` (migration 0003): a ordem em que o Unit of Work emite os `INSERT`s não importa, e a integridade é verificada no commit.

### Migrations

SQL puro e versionado em `src/shared/infrastructure/database/migrations/sql/NNNN_nome.{up,down}.sql`, executado pelo Migrator do MikroORM. O runner é um script Bun (`migrate.ts`) porque a CLI do MikroORM não carrega a configuração TypeScript sob o Bun. O teste `schema.test.ts` aplica todas as migrations, reverte todas e aplica de novo.

## 7. Concorrência

**Unidade de concorrência: a wallet.** Estratégia: **lock pessimista por wallet** (`SELECT … FOR UPDATE` via `LockMode.PESSIMISTIC_WRITE`) dentro da transação.

Por que pessimista e não otimista:

- **Hot wallet**: com lock otimista, N escritores concorrentes na mesma wallet geram até N−1 conflitos por rodada e retries em cascata; a latência cresce de forma imprevisível. Com lock pessimista, eles formam uma fila curta no PostgreSQL e cada um espera só a transação anterior (milissegundos).
- **Correção mais simples de provar**: o caminho é ler-com-lock → decidir → gravar; não existe "read → calculate → update" sem controle.
- **Ainda há uma barreira otimista**: `version` e `UNIQUE (wallet_id, wallet_version)` no ledger fariam um escritor fora do protocolo falhar em vez de corromper o saldo.

Detalhes que importam:

- **Sem lock global**: wallets diferentes nunca disputam o mesmo lock. Um teste segura o lock da wallet A numa transação aberta e verifica que a wallet B continua processando normalmente.
- **Ordem de locks única**: todo caminho que altera saldo trava primeiro a wallet; a transação é relida depois do lock. Isso evita deadlock entre `ProcessWagerTransaction` e `SettlePendingReference`.
- **Lookup de idempotência antes do lock**: um replay não espera na fila da wallet. Depois do lock a busca é repetida (`racedWhileWaitingForLock`), porque outra instância pode ter gravado a mesma chave durante a espera.
- **Lock timeout**: excedido, a operação vira 503 / retry, nunca efeito parcial. É contado na métrica `wagering_lock_conflicts_total`.

Cenário obrigatório (100.00 com duas apostas de 80.00) e variações (mesma aposta 50× em paralelo, hot wallet com 200 apostas, 3 processos independentes) estão em `test/concurrency/wallet-races.test.ts`.

## 8. Idempotência

- **Fonte da verdade**: o header `Idempotency-Key` no HTTP e `data.idempotencyKey` na fila; padrão recomendado `{providerId}:{externalTransactionId}`.
- **Persistente**: a chave é coluna única de `wager_transactions`. Não há cache em memória.
- **payloadHash**: SHA-256 (hex) do **JSON canônico** do subconjunto de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money {amount, currency}` e `referenceExternalTransactionId`. JSON canônico = chaves ordenadas lexicograficamente em todos os níveis, sem espaços, campos `undefined` omitidos, `amount` já chega na forma canônica de 2 casas, porque outra forma é recusada na validação. A chave de idempotência, headers e metadados de transporte não entram.
- **Mesma chave, mesmo hash** → resultado original com `idempotentReplay: true` (HTTP 200 para PROCESSED; a mesma resposta 202 ou 422 para os outros estados).
- **Mesma chave, hash diferente** → `409 IDEMPOTENCY_KEY_CONFLICT`. Nunca é replay.
- **Mesmo `(providerId, externalTransactionId)` com outra chave** → `409 EXTERNAL_TRANSACTION_ID_CONFLICT`.
- **Inbox**: quando a entrada é a fila, `(consumer_name, message_id)` é gravado na mesma transação (ver [§10](#10-mensageria-consumidor-sqs-inbox-e-dlq)).

## 9. API HTTP e contrato de erros

| Situação | Status | Corpo |
|---|---|---|
| Transação aplicada agora | `201` | `{ transactionId, status: "PROCESSED", balance, idempotentReplay: false }` |
| Replay de transação aplicada | `200` | idem, `idempotentReplay: true` |
| Aceita, aguardando referência | `202` | `status: "PENDING_REFERENCE"` |
| Rejeitada por regra de negócio | `422` | `status: "REJECTED"`, `failureCode`, `providerAction` |
| Payload inválido / header ausente | `400` | `{ error: { code, message, field?, retryable: false } }` |
| Sem token ou token inválido | `401` | `UNAUTHORIZED` (ver [§15](#15-autenticação)) |
| Provedor autenticado agindo por outro | `403` | `PROVIDER_MISMATCH` |
| Wallet ou transação inexistente | `404` | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` |
| Conflito de idempotência ou de id externo; wallet duplicada | `409` | `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_ID_CONFLICT`, `WALLET_ALREADY_EXISTS` |
| Falha transitória (banco fora, lock timeout) | `503` + `Retry-After` | `TRANSIENT_INFRASTRUCTURE_ERROR`, `retryable: true` |
| Erro inesperado | `500` | `INTERNAL_ERROR` |

**Contrato fechado**: campos fora do contrato são recusados com `400 VALIDATION_ERROR` e `field` apontando o campo (por exemplo `bonus` ou `money.fee`), tanto no HTTP quanto em `data` da fila (onde vira erro permanente e vai para a DLQ). Num serviço financeiro, um campo ignorado em silêncio é um erro de integração escondido: o provedor acredita que enviou uma informação que não teve efeito. A recusa explícita também mantém o `payloadHash` honesto, já que o hash cobre exatamente os campos aceitos. No HTTP, `idempotencyKey` no corpo também é recusado: a fonte da verdade é o header. Evoluções do contrato entram como nova versão do campo ou do endpoint, não como campo tolerado.

A regra para o provedor: **2xx** = resultado registrado; **422** = registrado e terminal, não reenviar igual; **4xx** = corrigir o payload; **503** = reenviar a mesma requisição, o que é seguro pela idempotência. A rejeição de negócio é 422 e não 409/400 porque a requisição era válida e foi registrada: o replay devolve o mesmo 422.

O cursor do ledger é opaco (base64url da `wallet_version`) e estável: lançamentos são append-only e ordenados por versão, então páginas não pulam nem repetem itens quando novos lançamentos chegam. A reconciliação (`POST /wallets/:id/reconciliation`) lê saldo e ledger no mesmo snapshot `REPEATABLE READ`; uma divergência é logada em `error`, contada em `wagering_reconciliation_divergences_total` e devolvida com `consistent: false`, nunca corrigida silenciosamente.

O Swagger em `/docs` documenta todos os endpoints, exemplos e respostas.

## 10. Mensageria: consumidor SQS, inbox e DLQ

### Fluxo

1. Long polling (`WaitTimeSeconds`) busca até 10 mensagens.
2. As mensagens são agrupadas por `MessageGroupId` (a `walletId`): grupos diferentes em paralelo, mesmo grupo em sequência.
3. O handler valida o envelope e chama `ProcessWagerTransaction` com os dados da inbox.
4. **Ack (`DeleteMessage`) somente depois do commit.**

### Inbox

Na mesma transação do efeito financeiro grava-se `(consumer_name, message_id, payload_hash)`. Se o processo morre depois do commit e antes do ack, a mensagem reaparece; o caso de uso encontra a inbox e devolve o resultado sem novo efeito. O teste "worker morto depois do commit e antes do ack" injeta exatamente essa falha. A deduplicação do SQS FIFO (janela de 5 minutos, só no envio) é tratada como otimização, nunca como garantia.

### Classificação de erros

| Tipo | Exemplos | Decisão |
|---|---|---|
| Negócio | saldo insuficiente, conflito de idempotência, wallet inexistente | **ack** — o resultado está registrado; repetir não muda nada |
| Transitório | banco indisponível, lock timeout | **retry** com backoff exponencial via `ChangeMessageVisibility` (2ⁿ s, teto de 300 s) |
| Permanente | JSON inválido, tipo desconhecido, contrato violado | **DLQ imediata**, com `failureReason` como atributo da mensagem |
| Desconhecido | bug | **retry**; se persistir, a redrive policy leva para a DLQ |

**Limite de tentativas**: a redrive policy da fila (`maxReceiveCount = 5`) move para a DLQ qualquer mensagem recebida 5 vezes sem ack. Isso funciona mesmo se o código tiver um bug no tratamento de erros.

**Wallet inexistente recebe ack, não vai para a DLQ.** O caso é tratado como erro de negócio: reprocessar não cria a wallet. A alternativa (DLQ para investigação manual) também é defensável; o evento fica nos logs com o código do erro.

### Shutdown (SIGTERM)

O Nest dispara `beforeApplicationShutdown`; cada worker gerenciado (`ManagedWorker`) para em ordem:

1. Para de buscar mensagens, cancelando o long polling em andamento com `AbortController`.
2. Termina a mensagem que está sendo processada (commit e ack).
3. Devolve as mensagens recebidas e ainda não iniciadas com `ChangeMessageVisibility(0)`, para outra instância pegar na hora.
4. Prazo máximo de 20 s (`WAGER_CONSUMER_SHUTDOWN_GRACE_MS`), abaixo do `stop_grace_period` de 30 s do compose. Se estourar, as mensagens voltam sozinhas após o visibility timeout.

## 11. Transactional Outbox

### Gravação

Os eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`) são gravados em `outbox_messages` **na mesma transação** do efeito. Nada é publicado antes do commit. Cada evento é uma subclasse de `IntegrationEvent` com `eventType` e `version` no tipo; o payload carrega `MoneyProps` (strings), nunca instâncias de `Money`.

### Publicação com múltiplos publishers

Cada instância roda um `OutboxRelay`:

1. **Claim** (uma instrução SQL curta): marca até N eventos vencidos com `locked_by` e `locked_until = now() + lease`, usando `FOR UPDATE SKIP LOCKED`. Publishers não se bloqueiam entre si.
2. **Claim ciente da wallet**: o claim ignora eventos de uma wallet cujo evento mais antigo pendente está alugado por outra instância. Sem isso, as instâncias pegavam blocos consecutivos de eventos das mesmas wallets e passavam a maior parte do tempo devolvendo lotes; o problema foi encontrado no teste de carga (ver [§14](#14-teste-de-carga)).
3. **Ordem por wallet**: os eventos são agrupados por `partition_key` (walletId) e ordenados por `position`, uma identity atribuída pelo banco no commit e serializada pelo lock da wallet. `occurred_at` não serve, porque empata no mesmo milissegundo. Antes de publicar uma wallet, o relay verifica se existe evento anterior dela ainda não publicado; se existir, devolve o lote.
4. **Publicação em lote**: `SendMessageBatch` com até 10 eventos, `MessageGroupId = walletId` e `MessageDeduplicationId = eventId`; depois um único `UPDATE` marca `published_at`.
5. **Falha**: o evento ganha `attempts + 1`, `last_error` e `next_attempt_at = now() + backoff` (500 ms a 60 s), tudo persistido. Os eventos seguintes **da mesma wallet** esperam; outras wallets seguem. Não há limite de tentativas: descartar um evento de transação confirmada violaria "não perder eventos confirmados". Um SQS fora do ar aparece como crescimento de `wagering_outbox_lag_seconds`.

O lease existe porque a chamada ao SQS acontece **fora** de transação: segurar uma conexão e locks de linha durante uma chamada de rede faria um SQS lento travar o banco. Se a instância morre segurando o lease, ele expira e outra instância assume.

### Garantia de entrega

**At-least-once com deduplicação por `eventId`.** Se o processo morre entre publicar e marcar, outra instância publica de novo. Duplicar é preferível a perder. A duplicata é inofensiva porque o SQS FIFO a descarta dentro de 5 minutos pelo `MessageDeduplicationId`, e o contrato com consumidores é deduplicar por `eventId`. O teste "processo morre depois de publicar e antes de marcar" cobre esse cenário.

## 12. Referências fora de ordem

- Referência ausente → `PENDING_REFERENCE`, evento `WagerTransactionPendingReference`, `next_reference_check_at` agendado. O saldo não muda.
- **Chegada da referência**: quando uma transação é processada, as pendências que apontam para ela têm `next_reference_check_at` antecipado para `now()` na mesma transação. Elas não esperam o próximo ciclo de backoff.
- **Worker** (`PendingReferenceSweeper`, em todas as instâncias): reivindica pendências vencidas com `FOR UPDATE SKIP LOCKED` e um lease (empurra `next_reference_check_at` para `now() + lease`), depois chama `SettlePendingReference`, que trava a wallet, relê a transação e reavalia. Se o worker morrer, o lease vence e outra instância reprocessa. A reavaliação é idempotente: uma transação que já saiu de `PENDING_REFERENCE` é ignorada.
- **Backoff e limite**: atraso `1 s × 2ⁿ` com teto de 5 minutos, no máximo 12 reavaliações **ou** 1 hora de idade, o que vier primeiro. Na prática a 12ª reavaliação acontece cerca de 18 minutos depois da chegada. A justificativa: provedores costumam entregar a operação original em segundos; minutos cobrem filas atrasadas e reprocessamentos; deixar uma reversão pendente por horas manteria o jogador com saldo errado por tempo demais. Esgotado o limite: `REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`.

## 13. Observabilidade

### Logs

Uma linha JSON por evento (`JsonLogger`), com `time`, `level`, `context`, `msg` e os campos de correlação da operação corrente: `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `externalTransactionId`. Os campos são propagados por `AsyncLocalStorage`: o middleware HTTP abre o contexto com o `x-correlation-id` (recebido ou gerado, e devolvido no header), o handler da fila abre com o `messageId`, e o caso de uso anota `transactionId` e `walletId` quando os conhece. A aplicação depende só da porta `DiagnosticContext`.

Dados sensíveis: chaves como `authorization`, `token`, `password`, `secret`, `api-key` e `cookie` são mascaradas em qualquer profundidade; corpos de requisição e payloads financeiros completos nunca são logados.

### Métricas (`GET /metrics`, Prometheus)

| Métrica | O que mostra |
|---|---|
| `wagering_transactions_total{kind,status,channel}` | transações novas por status e canal |
| `wagering_duplicates_detected_total{channel}` | replays idempotentes (HTTP e redelivery) |
| `wagering_transaction_duration_seconds{channel,result}` | latência de processamento (histograma) |
| `wagering_transaction_errors_total{channel,code}` | submissões que terminaram em erro |
| `wagering_db_retries_total{reason}` | retries da unidade de trabalho (`unique_race`, `transient`) |
| `wagering_lock_conflicts_total{outcome}` | lock timeouts (`retried`, `gave_up`) |
| `wagering_queue_messages_total{queue,disposition}` | mensagens por decisão (`ack`, `retry`, `dead_letter`) |
| `wagering_queue_message_duration_seconds` | tempo até a decisão |
| `wagering_dead_letter_queue_messages{queue}` | profundidade da DLQ (inclui redrive automático) |
| `wagering_outbox_pending_events` | eventos confirmados ainda não publicados |
| `wagering_outbox_lag_seconds` | idade do evento pendente mais antigo |
| `wagering_outbox_events_total{result,event_type}` | publicações e falhas |
| `wagering_pending_references{state}` | pendências aguardando e vencidas |
| `wagering_pending_reference_resolutions_total{result}` | resultados do worker |
| `wagering_reconciliation_divergences_total` | divergências saldo × ledger |
| `wagering_process_*`, `wagering_nodejs_*` | métricas padrão do processo |

Todas carregam o label `instance`. Gauges lidos do banco ou do SQS têm tempo máximo de coleta (2 s): um SQS lento não trava o scrape.

### Health checks

`/health/live` não toca dependências (o processo está vivo). `/health/ready` verifica PostgreSQL (`SELECT 1`) e SQS (`GetQueueAttributes`) e devolve 503 se algum falhar. Ambos são públicos.

## 14. Teste de carga

`bun run test:load` (`test/load/run.ts`) roda contra instâncias em execução.

### Metodologia

1. Cria 50 wallets com saldo alto (para que rejeições não mascarem a medição).
2. Fase principal: N submissões (65% BET, 20% WIN, 15% LOSS) com **20% do tráfego numa única wallet** (hot wallet) e **10% de reenvios idempotentes**, distribuídas em round-robin pelas 3 instâncias, com concorrência fixa.
3. Segunda fase: REFUND de 5% das BETs processadas.
4. Respostas 503 são reenviadas como faria um provedor (até 4 tentativas, respeitando `Retry-After`); a taxa de erro conta apenas as que falharam no final.
5. Durante a carga, `/metrics` é amostrado a cada 250 ms (pendentes e lag da outbox); um consumidor downstream lê e apaga a fila de eventos e conta `eventId`s distintos.
6. Ao final: espera a outbox drenar, reconcilia todas as wallets e coleta conflitos de lock e retries de todas as instâncias.

### Resultado principal (Docker Compose + LocalStack)

Ambiente: Windows 11 com Docker Desktop, AMD Ryzen 7 5700G (16 threads), 15.4 GB. O `docker compose up --build` do repositório (3 instâncias, PostgreSQL 16, LocalStack 3.8) e o gerador de carga rodando na mesma máquina, com os parâmetros padrão: 5 000 submissões, concorrência 64, 20% numa hot wallet e 10% de reenvios.

| Métrica | Valor |
|---|---|
| Requisições | 5 136 em 27.2 s |
| Throughput | **188 req/s** |
| Latência p50 / p95 / p99 / máx | **88 / 1 587 / 2 101 / 2 592 ms** |
| p50 dos replays idempotentes | 63 ms |
| Taxa de erro / retries do cliente | 0% / 0 |
| Status | 4 634 × 201, 502 × 200 (replays) |
| Conflitos de lock / retries de banco | 0 / 0 |
| Pico de eventos pendentes na outbox | 151 |
| **Pico de lag da outbox** | **0.9 s** |
| Drenagem da outbox após a carga | 0.04 s |
| Eventos entregues ao consumidor downstream | 8 631 distintos, 0 repetidos |
| Wallets reconciliadas / divergentes | 50 / 0 |

### Medições num ambiente restrito (moto, 2 vCPUs)

Durante o desenvolvimento a carga também foi rodada num container de nuvem com 2 vCPUs, sem acesso ao Docker Hub, com o SQS emulado pelo **moto** e tudo (3 instâncias, PostgreSQL, emulador e gerador) na mesma máquina:

| | Concorrência 64 | Concorrência 8 |
|---|---|---|
| Throughput | 120 req/s | 121 req/s |
| p50 / p95 / p99 | 180 / 2 512 / 4 199 ms | 47 / 192 / 282 ms |
| Pico de lag da outbox | 82 s | 30 s |
| Erros / divergências / eventos repetidos | 0 / 0 / 0 | 0 / 0 / 0 |

### Análise

- **Correção sob carga**: nas três rodadas, nenhuma divergência entre saldo e ledger, nenhum débito duplicado apesar de ~10% de reenvios, nenhum evento entregue duas vezes, nenhum 5xx e nenhum lock timeout, com 20% do tráfego numa única wallet.
- **Outbox**: com LocalStack o lag ficou abaixo de 1 s durante toda a carga, com 8 631 eventos (~1.7 por submissão) publicados por 3 relays concorrentes, e a fila esvaziou logo depois. No ambiente restrito o lag chegou a 82 s porque o moto é o gargalo: medindo os passos do relay ali, claim 12 ms, mark 2 ms e `SendMessageBatch` de 10 eventos ~680 ms (a implementação FIFO do moto piora com o tamanho da fila). Os números do moto não refletem a capacidade do relay.
- **O teste de carga encontrou um problema real de coordenação**, já corrigido: na primeira rodada (sem lote e sem claim ciente da wallet), o pico de lag foi de 196 s e a drenagem levou 177 s, porque as 3 instâncias reivindicavam blocos consecutivos das mesmas wallets e a maioria dos lotes era devolvida. A correção (claim que pula wallets alugadas por outra instância e publicação em lote) tem testes de regressão em `outbox-relay.test.ts`.
- **A cauda de latência é fila, não erro**: com 64 requisições em voo e ~190 req/s, a lei de Little dá ~340 ms de espera média. A cauda vem de requisições esperando conexão do pool (20 por instância) e o lock da hot wallet, que serializa 20% do tráfego. A rodada com concorrência 8 mostra o mesmo throughput com p99 de 282 ms, ou seja, acima do ponto de saturação a concorrência extra só vira espera. Os replays são os mais rápidos porque a chave de idempotência é consultada antes do lock.
- **Limites que existem por desenho**: os eventos de uma mesma wallet são publicados em série (ordem por wallet), e o SQS FIFO real tem limite de vazão por fila sem o modo high-throughput. A vazão escala com o número de wallets ativas, não com o volume de uma única wallet.

## 15. Autenticação

Implementada com **Keycloak** como Identity Provider externo e **OAuth2 client credentials**: os provedores de jogos são sistemas, não pessoas, então cada provedor é um *client* com segredo próprio e recebe um access token JWT. Não existe tabela de usuários nem senha no serviço.

### Fluxo

```
provedor ── client_id + client_secret ──► Keycloak (realm "wagering")
         ◄────────── access token (JWT, RS256, 15 min) ──────────┘
provedor ── Authorization: Bearer <token> ──► API
                                              ProviderAuthGuard → JwtProviderIdentityAdapter
                                              valida assinatura (JWKS), iss, aud, exp
                                              providerId = claim "azp"
```

### Peças

- **`ProviderIdentityPort`** (`src/auth/provider-identity.port.ts`): resolve a identidade a partir dos headers. A aplicação só conhece essa porta.
- **`JwtProviderIdentityAdapter`**: valida o token com a biblioteca `jose` contra o JWKS do realm (chaves em cache, com timeout e cooldown de refetch), exigindo `iss`, `aud = wagering-processor`, `exp` (tolerância de 5 s) e algoritmo assimétrico (`RS256`, `PS256`, `ES256`; `alg: none` e HMAC são recusados). O `providerId` vem da claim configurável `AUTH_PROVIDER_CLAIM`, por padrão `azp`, que no fluxo client credentials é o `client_id`.
- **`AllowAllProviderIdentityAdapter`**: usado com `AUTH_MODE=disabled` (padrão fora do compose e nos testes de integração que não tratam de autenticação).
- **`ProviderAuthGuard`**: guard global. Rotas marcadas com `@Public()` (health, métricas e documentação) passam; as demais exigem identidade.

### Autorização: o provedor só age em nome próprio

Autenticar não basta: um provedor válido não pode submeter transações em nome de outro. A regra fica no caso de uso, não no controller, para valer em qualquer canal que informe um provedor autenticado: `ProcessWagerTransaction` recebe `actingProviderId` e rejeita com `403 PROVIDER_MISMATCH` quando ele difere do `providerId` do corpo, **antes** de qualquer escrita. Nas consultas, `GET /providers/:providerId/...` de outro provedor é 403; `GET /wagering/transactions/:id` de outro provedor responde 404, para não revelar que o id existe.

### Respostas

| Situação | Status |
|---|---|
| Sem token, token malformado, assinatura inválida, expirado, emissor ou audiência errados | `401 UNAUTHORIZED` com `WWW-Authenticate: Bearer` |
| Token válido de outro provedor | `403 PROVIDER_MISMATCH` |
| Keycloak inalcançável para buscar as chaves | `503 TRANSIENT_INFRASTRUCTURE_ERROR` com `Retry-After`, porque o token pode ser válido e reenviar é seguro |

### Configuração no compose

- O realm `wagering` é importado na subida (`infra/keycloak/wagering-realm.json`) com os clients `provider-a`, `provider-b` e `load-provider`. Cada client tem só *service account* habilitado (sem login de usuário) e um mapper que coloca `wagering-processor` no `aud`.
- `KC_HOSTNAME=http://localhost:8080` fixa o emissor do token, quem quer que o peça; `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` deixa as instâncias buscarem o JWKS pela rede interna (`http://keycloak:8080/...`). Sem isso, um token pedido pelo host teria `iss` diferente do esperado dentro do container.
- As instâncias só sobem depois do health check do Keycloak.
- **Swagger**: o botão **Authorize** usa o mesmo fluxo client credentials direto no Keycloak (esquema OAuth2 publicado no OpenAPI quando `AUTH_MODE=jwt`). Para o navegador poder chamar o Keycloak, os clients `provider-a` e `provider-b` aceitam CORS apenas das origens do Swagger (`localhost:3000`–`3002`).

### Escopo e decisões

- **Mensagens da fila** seguem como canal interno confiável, conforme o desafio; o `providerId` do payload passa pelas mesmas validações de domínio. Em produção, a autorização do canal assíncrono seria feita por política de acesso à fila (IAM).
- **Wallets não são escopadas por provedor**: a wallet pertence ao jogador e é compartilhada entre provedores no modelo do desafio. Com um vínculo provedor ↔ jogador, as rotas de wallet passariam pela mesma regra.
- **Readiness não depende do Keycloak**: com as chaves em cache, tokens continuam sendo validados durante uma indisponibilidade curta do IdP; derrubar todas as instâncias por isso pioraria a disponibilidade.
- Os segredos dos clients estão no arquivo do realm por ser ambiente de desenvolvimento; em produção viriam de um cofre e seriam rotacionados.

### Credenciais para acessar a documentação

Com o compose no ar, abra `http://localhost:3000/docs`, clique em **Authorize** e preencha o bloco **keycloak (OAuth2, clientCredentials)** com um dos clients abaixo. O Swagger obtém o token no Keycloak e o envia em todas as chamadas; não é preciso copiar token.

| client_id | client_secret | Uso |
|---|---|---|
| `provider-a` | `provider-a-secret` | provedor de exemplo |
| `provider-b` | `provider-b-secret` | segundo provedor, para ver o `403 PROVIDER_MISMATCH` |
| `load-provider` | `load-provider-secret` | teste de carga |

O passo a passo completo, com o roteiro de chamadas, está no `README.md`, em "Testando pelo Swagger".

## 16. Estratégia de testes

- **Unidade**: domínio puro (`Money`, `Wallet`, `WagerTransaction`, `ReferencePolicy`, `WagerSettlementService`, eventos, logger), sem I/O.
- **Integração com dependências reais**: cada arquivo cria um banco PostgreSQL próprio, migrado do zero, e filas SQS exclusivas (FIFO e DLQ com redrive). Nenhum teste substitui PostgreSQL ou SQS por mock.
- **Falhas injetadas por decorators**, não por mocks do sistema: uma `MessageQueue` cujo `acknowledge` falha uma vez simula o crash entre commit e ack; um `UnitOfWork` que lança erro transitório N vezes simula banco instável; um `Clock` adiantado ou atrasado simula relógio defasado.
- **Concorrência real**: `Promise.all` com dezenas de operações sobre pools de conexão reais, e testes com **3 processos Bun independentes** competindo pela mesma wallet.
- **Reinício**: o teste de recuperação sobe a aplicação como processo real, mata com `SIGKILL` no meio da carga, sobe outra instância e comprova o estado final: todas as mensagens processadas exatamente uma vez, inbox completa, nenhuma pendência, saldo igual ao ledger em todas as wallets, cadeia de versões contígua, todos os eventos da outbox entregues e DLQ vazia. Em Linux e macOS, também confirma pelos logs JSON o shutdown limpo dos 3 workers após `SIGTERM`; no Windows essa checagem é pulada, porque lá o sinal encerra o processo à força (o shutdown limpo continua coberto pelo teste de SIGTERM do consumidor, que roda em qualquer sistema).
- **Determinismo**: esperas por estado usam `eventually` com prazo, nunca um `sleep` fixo. `sleep` só aparece onde o próprio cenário é temporal (expiração de lease, backoff), sempre com políticas curtas injetadas e folga em relação ao prazo.

## 17. Lições aprendidas durante o desenvolvimento

**Diferença de relógio entre aplicação e banco.** Na primeira execução contra o LocalStack, dois testes da outbox falharam. A aplicação gravava `next_attempt_at` com o relógio dela (Windows), e o claim comparava com `now()` do PostgreSQL (container no WSL, cujo relógio estava atrás). Eventos recém-criados pareciam agendados para o futuro e não eram publicados. O problema não aparecia com emuladores rodando na mesma máquina, porque ali existia um só relógio. A correção foi tornar o banco a única fonte de tempo para agendamento: inserção com `DEFAULT now()`, reagendamento com `now() + intervalo` calculado em SQL, e o "expedite" de pendências também em SQL. A aplicação decide **quanto** esperar (regra de backoff no domínio); o banco decide **a partir de quando**. Há testes de regressão com o relógio da aplicação 5 s adiantado e 5 s atrasado.

**Testar com carga revela problemas que testes funcionais não mostram.** A coordenação entre publishers estava correta (nada perdido, nada fora de ordem), mas era ineficiente com 3 instâncias. Só o teste de carga mostrou isso (ver [§14](#14-teste-de-carga)).

## 18. Limitações e próximos passos

| Limitação | Impacto | Próximo passo |
|---|---|---|
| Segredos dos clients do Keycloak versionados no arquivo do realm | aceitável só em desenvolvimento | segredos em cofre (Vault, Secrets Manager) e rotação |
| Rotas de wallet autenticadas, mas não escopadas por provedor | um provedor autenticado consulta wallets de jogadores de outro provedor | vínculo provedor ↔ jogador e a mesma regra de `PROVIDER_MISMATCH` |
| Sem rate limiting por provedor | um provedor pode saturar as instâncias | limite por `providerId` no gateway ou na aplicação |
| Status `FAILED` modelado no domínio e no schema, mas nenhum fluxo o produz | um erro permanente de infraestrutura dentro da transação faz rollback de tudo, então não há o que registrar como `FAILED` sem uma segunda transação; hoje vira HTTP 500 ou DLQ, com log | gravar a falha numa transação separada após o rollback, quando houver um caso permanente identificável |
| Falha parcial dentro de um `SendMessageBatch` | se o SQS aceitar um evento posterior e recusar um anterior da mesma wallet, o consumidor pode ver o posterior antes; nenhum evento se perde e a duplicata é deduplicada por `eventId` | publicar uma mensagem por chamada quando a ordem estrita for mais importante que a vazão |
| `outbox_messages` e `inbox_messages` crescem indefinidamente | custo de armazenamento e de índices com o tempo | job de retenção (por exemplo, apagar publicados com mais de 7 dias) ou particionamento por data |
| Reconciliação só sob demanda | divergências só aparecem quando alguém chama o endpoint | job periódico que reconcilia wallets alteradas recentemente |
| `created_at` e o TTL de 1 h das pendências usam o relógio da aplicação | defasagem de segundos entre instâncias desloca o TTL na mesma proporção, irrelevante perto de 1 h | usar `now()` também na inserção da transação |
| Vazão de uma única wallet é serial por desenho | uma wallet muito quente limita a própria latência | aceitável: é o preço da correção; wallets diferentes escalam em paralelo |
| Teste de carga com gerador, banco, broker e instâncias na mesma máquina | latência inclui a disputa de CPU entre todos os componentes | repetir com instâncias e banco em máquinas separadas |

# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) vindas de múltiplos provedores, por HTTP e por SQS, permanecendo correto com mensagens duplicadas, fora de ordem e processadas simultaneamente por várias instâncias.

**Stack:** Bun 1.x · TypeScript estrito · NestJS 11 · PostgreSQL 16 · MikroORM 6 · AWS SQS (LocalStack) · Keycloak (OAuth2 client credentials) · Docker Compose · Prometheus (`prom-client`).

As decisões técnicas, trade-offs e limitações estão em [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Pré-requisitos

| Ferramenta | Para quê |
|---|---|
| Docker com Compose v2 | subir a aplicação completa (obrigatório) |
| [Bun 1.x](https://bun.sh) | rodar os testes, o teste de carga ou a aplicação fora do container |

Portas usadas no host: `3000`–`3002` (aplicação), `5432` (PostgreSQL), `4566` (LocalStack) e `8080` (Keycloak). Elas precisam estar livres.

## Subir tudo com Docker Compose

```bash
git clone https://github.com/igor-montezuma-dev/backend-challenge.git
cd backend-challenge
docker compose up --build -d
docker compose ps
```

A primeira subida leva de 1 a 3 minutos (build da imagem, download das imagens e ~30 s do Keycloak). Está pronto quando `postgres`, `localstack`, `keycloak` e as três réplicas de `app` aparecem como `healthy`; o serviço `migrate` aplica as migrations e termina (por isso não aparece na lista). Logs: `docker compose logs -f app`.

O compose sobe, nesta ordem:

| Serviço | O que faz |
|---|---|
| `postgres` | PostgreSQL 16 (`localhost:5432`, usuário/senha `postgres`) |
| `localstack` | SQS com as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (redrive após 5 recebimentos) e `wagering-events.fifo` |
| `keycloak` | Identity Provider em `localhost:8080` com o realm `wagering` importado (console admin: `admin` / `admin`) |
| `migrate` | aplica as migrations e termina |
| `app` × 3 | três instâncias da aplicação em `localhost:3000`, `3001` e `3002`, todas com autenticação JWT, consumidor SQS, publisher da outbox e worker de referências pendentes |

Com tudo `healthy`:

- Swagger: <http://localhost:3000/docs>
- Liveness: <http://localhost:3000/health/live>
- Readiness (PostgreSQL e SQS): <http://localhost:3000/health/ready>
- Métricas Prometheus: <http://localhost:3000/metrics>

Para parar e apagar os dados: `docker compose down -v`.

## Autenticação

Com o compose, as rotas de wallets e transações exigem um token do Keycloak (health, métricas e `/docs` são públicos). Cada provedor de jogos é um *client* OAuth2 com o fluxo **client credentials**:

| client_id | client_secret | Uso |
|---|---|---|
| `provider-a` | `provider-a-secret` | provedor de exemplo |
| `provider-b` | `provider-b-secret` | segundo provedor, para testar o isolamento |
| `load-provider` | `load-provider-secret` | teste de carga |

Obter um token (válido por 15 minutos):

```bash
curl -s -X POST http://localhost:8080/realms/wagering/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret
```

No PowerShell:

```powershell
$token = (Invoke-RestMethod -Method Post -Uri http://localhost:8080/realms/wagering/protocol/openid-connect/token `
  -Body @{ grant_type = "client_credentials"; client_id = "provider-a"; client_secret = "provider-a-secret" }).access_token
```

No Swagger (`/docs`), clique em **Authorize** e cole o `access_token`. Roteiro rápido para conferir: `POST /wallets` sem token → 401; com token → wallet criada; `POST /wagering/transactions` com o `walletId`/`playerId` dela → 201; a mesma requisição de novo → 200 com `idempotentReplay: true`. O provedor do token precisa ser o mesmo `providerId` do corpo: `provider-b` submetendo uma transação de `provider-a` recebe `403 PROVIDER_MISMATCH`. Para rodar sem autenticação, use `AUTH_MODE=disabled`.

## Rodar localmente (fora do container)

Pré-requisito: [Bun 1.x](https://bun.sh).

```bash
bun install
cp .env.example .env
docker compose up -d postgres localstack keycloak
bun run migration:up
bun run start
```

Não suba o serviço `app` do compose ao mesmo tempo: as duas formas usam a porta `3000`.

## Comandos

| Comando | Descrição |
|---|---|
| `bun run start` | sobe a API e os workers |
| `bun run start:dev` | idem, com reload |
| `bun run typecheck` | `tsc --noEmit` em modo estrito |
| `bun run migration:up` | aplica migrations pendentes |
| `bun run migration:down` | reverte a última migration |
| `bun run migration:list` | lista migrations aplicadas e pendentes |
| `bun test` | todos os testes |
| `bun run test:unit` | domínio puro (sem I/O) |
| `bun run test:integration` | PostgreSQL e SQS reais |
| `bun run test:concurrency` | corridas reais, inclusive com 3 processos |
| `bun run test:load` | teste de carga contra instâncias em execução |

## Testes

Os testes de integração e concorrência usam **PostgreSQL e SQS reais** — nenhum mock substitui o banco ou a fila. Com `postgres` e `localstack` de pé (o compose completo também serve):

```bash
bun install
docker compose up -d postgres localstack
bun test
```

Não é preciso `.env` para os testes. A suíte completa leva cerca de 1 minuto.

Cada arquivo de teste cria o próprio banco temporário (migrado do zero) e filas SQS exclusivas, então os arquivos não interferem entre si e podem rodar em qualquer ordem. Variáveis opcionais: `TEST_DATABASE_ADMIN_URL` (padrão `postgres://postgres:postgres@localhost:5432/postgres`) e `TEST_SQS_ENDPOINT` (padrão `SQS_ENDPOINT` ou `http://localhost:4566`).

Cobertura dos cenários pedidos no desafio:

| Cenário | Onde |
|---|---|
| Money, Wallet, regras de BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, payload divergente | `test/unit/*` |
| Migrations up/down e constraints do schema | `test/integration/schema.test.ts` |
| Atomicidade wallet + ledger + inbox + outbox | `test/integration/process-wager.test.ts` |
| Inbox, redelivery, retry, DLQ, SIGTERM, worker morto entre commit e ack | `test/integration/sqs-consumer.test.ts` |
| Publishers concorrentes, crash entre publicar e marcar, SQS fora do ar, relógio defasado | `test/integration/outbox-relay.test.ts` |
| Worker de PENDING_REFERENCE (vencimento, concorrência, lease, expiração) | `test/integration/pending-reference-sweeper.test.ts` |
| Reinício do serviço com comprovação da consistência final (SIGKILL de processo real) | `test/integration/restart-recovery.test.ts` |
| 100.00 com duas apostas de 80.00, mesma aposta 50× em paralelo, hot wallet, wallets em paralelo, ≥ 3 processos | `test/concurrency/wallet-races.test.ts` |
| API HTTP, status codes, OpenAPI, métricas e correlation id | `test/e2e/http-api.test.ts` |
| Autenticação: validação do JWT, 401, 403 entre provedores, rotas públicas, IdP fora do ar | `test/unit/jwt-provider-identity.test.ts`, `test/e2e/auth.test.ts` |

Todos os testes que movimentam saldo terminam verificando a invariante `wallet.balance == saldo reconstruído pelo ledger`.

## Teste de carga

Com o compose completo rodando:

```bash
bun install
cp .env.example .env
bun run test:load
```

O `.env` é usado só para saber qual fila de eventos o consumidor simulado deve ler; sem ele, a carga roda normalmente e o relatório mostra `downstream: "disabled"`.

Parâmetros por variável de ambiente:

| Variável | Padrão | Significado |
|---|---|---|
| `LOAD_BASE_URLS` | `http://localhost:3000,…3001,…3002` | instâncias (round-robin) |
| `LOAD_WALLETS` | `50` | wallets criadas |
| `LOAD_REQUESTS` | `5000` | submissões na fase principal |
| `LOAD_CONCURRENCY` | `64` | requisições simultâneas |
| `LOAD_HOT_WALLET_RATIO` | `0.2` | fração das requisições na mesma wallet (contenção) |
| `LOAD_DUPLICATE_RATIO` | `0.1` | fração de reenvios idempotentes |
| `LOAD_REFUND_RATIO` | `0.05` | fração das BETs revertidas por REFUND na segunda fase |
| `LOAD_CONSUME_EVENTS` | `true` | simula um consumidor downstream lendo `SQS_EVENTS_QUEUE_URL` |
| `LOAD_AUTH` | `true` | obtém token do Keycloak (`false` para API com `AUTH_MODE=disabled`) |
| `LOAD_TOKEN_URL`, `LOAD_CLIENT_ID`, `LOAD_CLIENT_SECRET` | realm `wagering`, `load-provider` | client usado pela carga |

O relatório (JSON) traz ambiente, throughput, p50/p95/p99 por tipo, distribuição de status, taxa de erro, retries, conflitos de lock, pico de lag da outbox, tempo de drenagem, eventos entregues ao consumidor e a reconciliação de todas as wallets. O processo sai com código 1 se alguma wallet divergir do ledger ou surgir um status inesperado. Metodologia e resultados medidos estão em [ARCHITECTURE.md › Teste de carga](./ARCHITECTURE.md#14-teste-de-carga).

## Exemplos de uso

Os exemplos em bash usam [`jq`](https://jqlang.github.io/jq/) para extrair o token.

```bash
TOKEN=$(curl -s -X POST http://localhost:8080/realms/wagering/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret | jq -r .access_token)

curl -s -X POST localhost:3000/wallets \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

curl -s -X POST localhost:3000/wagering/transactions \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>","roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

No PowerShell, prefira o Swagger (`/docs`) ou `Invoke-RestMethod`, porque o `curl` do Windows trata aspas de forma diferente.

Publicar uma transação pela fila (LocalStack; credenciais fictícias):

```bash
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 \
aws --endpoint-url http://localhost:4566 sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z","data":{ ... }}'
```

## Configuração

Todas as variáveis estão em [.env.example](./.env.example). As principais:

| Variável | Padrão | Uso |
|---|---|---|
| `DATABASE_URL` | — | conexão PostgreSQL |
| `DATABASE_POOL_MAX` | `20` | conexões por instância |
| `WALLET_LOCK_TIMEOUT_MS` | `5000` | espera máxima pelo lock de uma wallet (excedido → 503) |
| `TRANSACTION_MAX_ATTEMPTS` | `4` | tentativas da unidade de trabalho em falhas transitórias |
| `SQS_ENDPOINT`, `SQS_WAGER_QUEUE_URL`, `SQS_WAGER_DLQ_URL`, `SQS_EVENTS_QUEUE_URL` | — | filas |
| `WAGER_CONSUMER_ENABLED` | `true` | consumidor da fila de entrada |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | publisher da outbox |
| `PENDING_REFERENCE_WORKER_ENABLED` | `true` | worker de referências pendentes |
| `INSTANCE_ID` | `hostname-pid` | identifica a instância nos leases e nas métricas |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` ou `error` |
| `AUTH_MODE` | `disabled` (compose: `jwt`) | `jwt` exige Bearer token; `disabled` aceita qualquer chamada |
| `AUTH_ISSUER`, `AUTH_AUDIENCE` | — (compose: realm `wagering`, `wagering-processor`) | emissor e audiência exigidos no token |
| `AUTH_JWKS_URL` | `{AUTH_ISSUER}/protocol/openid-connect/certs` | onde buscar as chaves públicas |
| `AUTH_PROVIDER_CLAIM` | `azp` | claim que identifica o provedor |

## Estrutura

```
src/
  shared/                 kernel compartilhado: Money, erros, eventos, Unit of Work, observabilidade
  modules/
    wagering/             bounded context financeiro (wallets, transações, ledger)
      domain/             agregados, value objects, políticas — sem NestJS nem ORM
      application/        casos de uso, portas, workers
      infrastructure/     MikroORM, SQL, composição, telemetria
      presentation/       HTTP (controllers) e mensageria (handler da fila)
    messaging/            inbox, outbox, consumidor e publisher SQS
  auth/                   autenticação: ProviderIdentityPort, adaptador JWT, guard global
  health/                 liveness e readiness
test/
  unit/  integration/  concurrency/  e2e/  load/
infra/keycloak/           realm importado pelo Keycloak
infra/localstack/         criação das filas
```

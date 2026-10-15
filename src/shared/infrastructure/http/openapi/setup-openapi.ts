import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { CORRELATION_HEADER } from "../request-context";

const DESCRIPTION = `
Processador distribuído de apostas: wallets, ledger imutável, idempotência persistente.

### Como o provedor deve interpretar o status (sem ler a mensagem)

| Status | Significado | Pode reenviar a mesma requisição? |
|---|---|---|
| **201** | Transação processada | — |
| **200** | Replay: a operação já existia; resultado original | sim (sempre o mesmo) |
| **202** | Aceita, aguardando a transação referenciada | sim (replay) |
| **400** | Payload inválido | não — corrija |
| **401** | Token ausente, inválido ou expirado | sim, com um token válido |
| **403** | \`providerId\` difere do provedor autenticado | não |
| **404** | Wallet / transação inexistente | não |
| **409** | Conflito: mesma Idempotency-Key com payload diferente, ou wallet duplicada | não com esta key |
| **422** | Rejeitada por regra de negócio (\`failureCode\` + \`providerAction\`) | sim (replay devolve 422 igual) |
| **503** | Falha transitória (\`Retry-After\`) — nada foi confirmado | **sim** |

O header **Idempotency-Key** é obrigatório e é a fonte da verdade
(padrão recomendado: \`{providerId}:{externalTransactionId}\`).

### Autenticação

Com \`AUTH_MODE=jwt\` (padrão do docker compose), as rotas de wallets e transações exigem
\`Authorization: Bearer <token>\` emitido pelo Keycloak (client credentials, um client por provedor).
Use o botão **Authorize** com um token obtido em
\`POST http://localhost:8080/realms/wagering/protocol/openid-connect/token\`.
Health, métricas e esta documentação são públicos.
`;

export function setupOpenApi(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle("Wagering Processor")
    .setDescription(DESCRIPTION)
    .setVersion("1.0")
    .addTag("wallets", "Wallets, ledger e reconciliação")
    .addTag("wagering", "Submissão e consulta de transações de aposta")
    .addTag("health", "Liveness e readiness (sem autenticação)")
    .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Access token do Keycloak (client credentials)" })
    .addGlobalParameters({
      name: CORRELATION_HEADER,
      in: "header",
      required: false,
      description: "Opcional. Propagado para logs e eventos; gerado se ausente.",
      schema: { type: "string" },
    })
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("docs", app, document, {
    jsonDocumentUrl: "docs/openapi.json",
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true, tryItOutEnabled: true },
  });
}

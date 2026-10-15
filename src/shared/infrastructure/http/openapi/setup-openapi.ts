import type { INestApplication } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../../../config/app.config";
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
| **400** | Payload inválido ou com campo fora do contrato (\`field\` indica qual) | não — corrija |
| **401** | Token ausente, inválido ou expirado | sim, com um token válido |
| **403** | \`providerId\` difere do provedor autenticado | não |
| **404** | Wallet / transação inexistente | não |
| **409** | Conflito: mesma Idempotency-Key com payload diferente, ou wallet duplicada | não com esta key |
| **422** | Rejeitada por regra de negócio (\`failureCode\` + \`providerAction\`) | sim (replay devolve 422 igual) |
| **503** | Falha transitória (\`Retry-After\`) — nada foi confirmado | **sim** |

O header **Idempotency-Key** é obrigatório e é a fonte da verdade
(padrão recomendado: \`{providerId}:{externalTransactionId}\`).

### Autenticação

Com \`AUTH_MODE=jwt\` (padrão do docker compose), as rotas de wallets e transações exigem um token do Keycloak.
Clique em **Authorize**, preencha em **keycloak (OAuth2, clientCredentials)** o \`client_id\` e o \`client_secret\`
de um provedor (\`provider-a\` / \`provider-a-secret\` ou \`provider-b\` / \`provider-b-secret\`) e confirme:
o Swagger obtém o token sozinho e o envia em todas as chamadas. O provedor do token precisa ser o mesmo
\`providerId\` do corpo da transação. Health, métricas e esta documentação são públicos.
`;

export const KEYCLOAK_SECURITY_SCHEME = "keycloak";

export function setupOpenApi(app: INestApplication): void {
  const { auth } = app.get<AppConfig>(APP_CONFIG);
  const builder = new DocumentBuilder()
    .setTitle("Wagering Processor")
    .setDescription(DESCRIPTION)
    .setVersion("1.0")
    .addTag("wallets", "Wallets, ledger e reconciliação")
    .addTag("wagering", "Submissão e consulta de transações de aposta")
    .addTag("health", "Liveness e readiness (sem autenticação)")
    .addGlobalParameters({
      name: CORRELATION_HEADER,
      in: "header",
      required: false,
      description: "Opcional. Propagado para logs e eventos; gerado se ausente.",
      schema: { type: "string" },
    });
  if (auth.mode === "jwt") {
    builder.addOAuth2(
      {
        type: "oauth2",
        description: "Client credentials do provedor no Keycloak; o Swagger obtém e renova o token sozinho",
        flows: { clientCredentials: { tokenUrl: `${auth.issuer}/protocol/openid-connect/token`, scopes: {} } },
      },
      KEYCLOAK_SECURITY_SCHEME,
    );
  }

  const document = SwaggerModule.createDocument(app, builder.build());
  SwaggerModule.setup("docs", app, document, {
    jsonDocumentUrl: "docs/openapi.json",
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true, tryItOutEnabled: true },
  });
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class MoneyDoc {
  @ApiProperty({
    example: "25.00",
    pattern: "^(0|[1-9]\\d{0,16})\\.\\d{2}$",
    description: "Decimal em string com exatamente 2 casas (\"25.00\"). Nunca number. Sem sinal, sem notação científica.",
  })
  amount!: string;

  @ApiProperty({ example: "BRL", pattern: "^[A-Z]{3}$", description: "ISO-4217" })
  currency!: string;
}

export class ApiErrorBodyDoc {
  @ApiProperty({ example: "VALIDATION_ERROR" }) code!: string;
  @ApiProperty({ example: "invalid amount \"1.001\": expected a non-negative decimal with at most 2 decimal places" })
  message!: string;
  @ApiPropertyOptional({ example: "money" }) field?: string;
  @ApiProperty({ example: false, description: "true = reenviar a MESMA requisição é seguro" }) retryable!: boolean;
}

export class ApiErrorDoc {
  @ApiProperty({ type: ApiErrorBodyDoc }) error!: ApiErrorBodyDoc;
}

import { Global, Module } from "@nestjs/common";
import { CLOCK } from "../application/clock";
import { ID_GENERATOR } from "../application/id-generator";
import { SystemClock } from "./system-clock";
import { UuidV7Generator } from "./uuid-v7.generator";

@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
  ],
  exports: [CLOCK, ID_GENERATOR],
})
export class SharedModule {}

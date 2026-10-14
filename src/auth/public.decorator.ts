import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "auth:isPublic";

/** Marca rotas que não exigem identidade de provedor (ex.: health checks). */
export const Public = (): ClassDecorator & MethodDecorator => SetMetadata(IS_PUBLIC, true);

import { InboxSchema } from "./inbox.record";
import { OutboxSchema } from "./outbox.record";

export const MESSAGING_ENTITIES = [InboxSchema, OutboxSchema];

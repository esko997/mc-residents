import type { z } from "zod";
import type { CommonsClient } from "./commons.ts";
import { guideFeedbackDefinition, guideUpdatesDefinition, type Reference } from "../../commons/src/resident-contracts-knowledge.ts";

export { guideFeedbackDefinition, guideUpdatesDefinition } from "../../commons/src/resident-contracts-knowledge.ts";
export type { Reference } from "../../commons/src/resident-contracts-knowledge.ts";

export function registerResidentTools(client: CommonsClient, _resident: string, names: readonly string[]): Promise<number> {
  return client.call<number>("knowledge", "registerResidentTools", { names });
}

/** Shared records live only at the hub; the credential supplies the resident identity. */
export class KnowledgeGaps {
  constructor(private client: CommonsClient, _resident: string, private project: () => string = () => "") {}

  private projectLabel(): string {
    try { return this.project().slice(0, 200); }
    catch { return ""; }
  }

  recordMiss(query: string): Promise<number> {
    return this.client.call<number>("knowledge", "recordMiss", { query, project: this.projectLabel() });
  }

  feedback(input: z.infer<typeof guideFeedbackDefinition.schema>): Promise<string> {
    return this.client.call<string>("knowledge", "feedback", { ...input, project: this.projectLabel() });
  }

  get(id: number): Promise<Reference | null> {
    return this.client.call<Reference | null>("knowledge", "get", { id });
  }

  list(page = 1): Promise<Reference[]> {
    return this.client.call<Reference[]>("knowledge", "list", { page });
  }

  exact(query: string): Promise<Reference | null> {
    return this.client.call<Reference | null>("knowledge", "exact", { query });
  }

  search(query: string): Promise<Reference[]> {
    return this.client.call<Reference[]>("knowledge", "search", { query });
  }

  updates(input: z.infer<typeof guideUpdatesDefinition.schema> = {}): Promise<string> {
    return this.client.call<string>("knowledge", "updates", input);
  }
}

import type { CommonsClient } from "./commons.ts";
import type { SocietyArgs, SocietyContext, SocietySnapshot } from "../../commons/src/resident-contracts-society.ts";

export { societyDefinitions, performerOf, beneficiaryOf, observationFreshness } from "../../commons/src/resident-contracts-society.ts";
export type { SocietySnapshot } from "../../commons/src/resident-contracts-society.ts";

/** Resident identity travels only in the client's bearer credential, never in arguments. */
export function createSociety({ client }: { client: CommonsClient; resident: string }): Society {
  return {
    collaborate: (input: SocietyArgs<"collaborate">) => client.call<string>("society", "collaborate", input),
    update: (input: SocietyArgs<"collaboration_update">) => client.call<string>("society", "update", input),
    show: (input: SocietyArgs<"collaboration_show">) => client.call<string>("society", "show", input),
    register: (input: SocietyArgs<"facility_register">) => client.call<string>("society", "register", input),
    updateFacility: (input: SocietyArgs<"facility_update">) => client.call<string>("society", "updateFacility", input),
    observe: (input: SocietyArgs<"facility_observe">) => client.call<string>("society", "observe", input),
    showFacility: (input: SocietyArgs<"facility_show">) => client.call<string>("society", "showFacility", input),
    snapshot: (context: SocietyContext = {}) => client.call<SocietySnapshot>("society", "snapshot", context),
  };
}

export interface Society {
  collaborate(input: SocietyArgs<"collaborate">): Promise<string>;
  update(input: SocietyArgs<"collaboration_update">): Promise<string>;
  show(input: SocietyArgs<"collaboration_show">): Promise<string>;
  register(input: SocietyArgs<"facility_register">): Promise<string>;
  updateFacility(input: SocietyArgs<"facility_update">): Promise<string>;
  observe(input: SocietyArgs<"facility_observe">): Promise<string>;
  showFacility(input: SocietyArgs<"facility_show">): Promise<string>;
  snapshot(context?: SocietyContext): Promise<SocietySnapshot>;
}

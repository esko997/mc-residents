import { z } from "zod";

/** Identity and receipt time belong to the hub, never to the caller. */
export const alarmRequestSchema = z.object({
  kind: z.enum(["auto", "manual"]),
  reason: z.string().max(120).transform(reason =>
    reason.replace(/§./g, "").replace(/[\p{Cc}\p{Cf}<>]/gu, " ").replace(/\s+/g, " ").trim()
  ).pipe(z.string().min(1)),
  x: z.number().finite(), y: z.number().finite(), z: z.number().finite(),
  dimension: z.string().max(120).trim().min(1),
  health: z.number().finite().nonnegative().optional(),
  maxHealth: z.number().finite().positive().optional(),
}).strict();
export type AlarmRequest = z.infer<typeof alarmRequestSchema>;

export const alarmEventSchema = alarmRequestSchema.extend({
  sender: z.string().regex(/^\w{1,40}$/),
  at: z.number().finite().nonnegative(),
}).strict();
export type AlarmEvent = z.infer<typeof alarmEventSchema>;

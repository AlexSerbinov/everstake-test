import { z } from "zod";

// Model output is an untrusted request for an action, never executable code.
const claimSchema = z.object({
  text: z.string().min(1).max(3000),
  citations: z.array(z.string()).min(1).max(10),
  asOf: z.string().nullable(),
  asOfBasis: z
    .enum(["effective", "published", "updated", "observed"])
    .optional(),
  asOfSource: z.string().optional(),
  temporalScope: z
    .enum(["current", "cumulative", "historical", "unspecified"])
    .optional(),
});
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("search"), query: z.string().min(1).max(1000) }),
  z.object({
    action: z.literal("read"),
    documentId: z.string(),
    offset: z.number().int().min(0).max(500).default(0),
    query: z.string().trim().min(1).max(500).optional(),
  }),
  z.object({
    action: z.literal("calculate"),
    operation: z.enum(["add", "subtract", "multiply", "divide"]).optional(),
    operands: z.array(z.number()).min(2).max(10).optional(),
    expression: z.string().max(200).optional(),
    citations: z.array(z.string()).min(1),
  }),
  z.object({
    action: z.literal("answer"),
    status: z.enum(["answered", "partial", "no_reliable_answer"]),
    claims: z.array(claimSchema).max(15),
    reason: z.string().optional(),
  }),
]);

export type ResearchAction = z.infer<typeof actionSchema>;

/** Accept fenced JSON, then validate every action before dispatching it. */
export function parseResearchAction(text: string): ResearchAction {
  return actionSchema.parse(
    JSON.parse(text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")),
  );
}

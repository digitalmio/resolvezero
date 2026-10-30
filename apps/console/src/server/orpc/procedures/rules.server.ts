import "@tanstack/react-start/server-only";

import { z } from "zod";

import { ORPCError } from "@orpc/server";

import { base } from "../router-base.server";
import { requireScope } from "../context.server";
import { auditWrite } from "../audit.server";
import { createRule, removeRule, setRuleEnabled } from "../../dashboard/rules.server";
import { normalizeRuleAction, normalizeRuleDomain } from "../../../lib/policy";

const ruleInput = z.object({
  domain: z.string().min(1).max(253).describe("Domain; subdomains match automatically."),
  action: z.enum(["block", "allow"]),
});

const ruleKey = z.object({
  domain: z.string().min(1).max(253),
});

const ruleToggle = ruleKey.extend({ enabled: z.boolean() });

const ruleOutput = z.object({
  domain: z.string(),
  action: z.enum(["block", "allow"]),
  enabled: z.boolean(),
});

function badRequest(err: unknown): never {
  throw new ORPCError("BAD_REQUEST", {
    message: err instanceof Error ? err.message : "Invalid rule",
  });
}

export const rules = {
  create: base
    .route({ method: "POST", path: "/rules", summary: "Add or replace a rule" })
    .input(ruleInput)
    .output(ruleOutput)
    .handler(async ({ input, context }) => {
      requireScope(context, "read-write");
      try {
        const rule = await createRule(context.principal.userId, {
          domain: normalizeRuleDomain(input.domain),
          action: normalizeRuleAction(input.action),
          profileId: context.profileId,
        });
        await auditWrite(context, {
          procedure: "rules.create",
          summary: `rule ${rule.domain} → ${rule.action}`,
        });
        return rule;
      } catch (err) {
        badRequest(err);
      }
    }),

  setEnabled: base
    .route({ method: "POST", path: "/rules/enabled", summary: "Enable or disable a rule" })
    .input(ruleToggle)
    .output(z.object({ domain: z.string(), enabled: z.boolean() }))
    .handler(async ({ input, context }) => {
      requireScope(context, "read-write");
      try {
        const row = await setRuleEnabled(
          context.principal.userId,
          input.domain,
          input.enabled,
          context.profileId,
        );
        await auditWrite(context, {
          procedure: "rules.setEnabled",
          summary: `rule ${row.domain} → ${row.enabled ? "enabled" : "disabled"}`,
        });
        return row;
      } catch (err) {
        badRequest(err);
      }
    }),

  delete: base
    .route({ method: "DELETE", path: "/rules", summary: "Delete a rule" })
    .input(ruleKey)
    .output(z.object({ ok: z.literal(true) }))
    .handler(async ({ input, context }) => {
      requireScope(context, "read-write");
      try {
        const result = await removeRule(
          context.principal.userId,
          normalizeRuleDomain(input.domain),
          context.profileId,
        );
        await auditWrite(context, {
          procedure: "rules.delete",
          summary: `rule ${input.domain} → deleted`,
        });
        return result;
      } catch (err) {
        badRequest(err);
      }
    }),
};

export type RulesProcedures = typeof rules;

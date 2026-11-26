import { emptySchema, estimateCostSchema } from "../../images/schemas";
import { estimateCost, getBalance, listPresets } from "../../images/service";
import { serviceFor } from "../context";
import type { ToolDefinition } from "../tool";

export const accountTools: ToolDefinition[] = [
  {
    name: "list_presets",
    title: "List size presets",
    description:
      "Show the size presets (pin, pin_hd, square, blog_hero, cover_6x9) with their pixel size and the credits one image costs.",
    schema: emptySchema,
    scope: "images:read",
    run: async (_input, caller) => ({ data: listPresets(await serviceFor(), caller) }),
  } as ToolDefinition,
  {
    name: "estimate_cost",
    title: "Estimate cost",
    description:
      "Credits needed for a planned call, with the current balance and whether it is enough. Use it before a big batch.",
    schema: estimateCostSchema,
    scope: "images:read",
    run: async (input, caller) => ({ data: await estimateCost(await serviceFor(), caller, input as never) }),
  } as ToolDefinition,
  {
    name: "get_balance",
    title: "Get credit balance",
    description: "Credits left in the account and the last 10 ledger lines.",
    schema: emptySchema,
    scope: "images:read",
    run: async (_input, caller) => ({ data: await getBalance(await serviceFor(), caller) }),
  } as ToolDefinition,
];

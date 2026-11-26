import { z } from "zod";
import { SCOPE_READ, SCOPE_WRITE } from "../../auth/scopes";
import { CHANGE_AT_LEAST_ONE, createShareSchema, listSharesSchema, updateShareFields } from "../../shares/schemas";
import { createShare, getShare, listShares, revokeShare, updateShare } from "../../shares/service";
import { defineTool, type ToolDefinition } from "../tool";

const shareId = z.string().regex(/^[a-z2-7]{26}$/, "Not a valid share id. Use an id from list_shares.");
const byShare = z.object({ share_id: shareId }).strict();

/** The tools talk about files, so a share is made from `file_ids`; the service calls the same ids artifacts. */
const createShareInput = createShareSchema
  .omit({ artifact_ids: true })
  .extend({ file_ids: createShareSchema.shape.artifact_ids.describe("Ids of the files to share, 1 to 50.") });

const updateShareInput = z
  .object({ share_id: shareId, ...updateShareFields })
  .strict()
  .refine((value) => Object.keys(value).length > 1, CHANGE_AT_LEAST_ONE);

export const shareTools: ToolDefinition[] = [
  defineTool({
    name: "list_shares",
    title: "List share links",
    description:
      "List share links, newest first, with their state (active, revoked, expired), view and download counts and whether they have a password. Revoked ones are left out unless include_revoked is true.",
    schema: listSharesSchema,
    scope: SCOPE_READ,
    run: async (input, caller, { shares }) => ({ data: { ...(await listShares(shares, caller, input)) } }),
  }),
  defineTool({
    name: "get_share",
    title: "Get a share link's details",
    description: "One share link with the files it contains. The password is never shown; it cannot be recovered.",
    schema: byShare,
    scope: SCOPE_READ,
    run: async (input, caller, { shares }) => ({
      data: { share: await getShare(shares, caller, input.share_id) },
    }),
  }),
  defineTool({
    name: "create_share",
    title: "Create a share link",
    description:
      'A long-term link on this service for 1 to 50 files: a single file opens a viewer with a preview and a download button, several show a list. Optional password (pass "generate" for a strong random one, which is returned once and cannot be shown again) and optional expiry; there is no download limit. It can be revoked at any time, and takes effect within 5 minutes. Always show the user the url and any generated password.',
    schema: createShareInput,
    scope: SCOPE_WRITE,
    run: async (input, caller, { shares }) => {
      const { file_ids, ...rest } = input;
      return { data: { ...(await createShare(shares, caller, { ...rest, artifact_ids: file_ids })) } };
    },
  }),
  defineTool({
    name: "update_share",
    title: "Change a share link",
    description:
      'Change a share\'s title, expiry (expires_in_days, or null for none) or password (a new one, "generate", or null to remove it). A new or removed password signs out everyone who had unlocked the link.',
    schema: updateShareInput,
    scope: SCOPE_WRITE,
    idempotent: true,
    run: async (input, caller, { shares }) => {
      const { share_id, ...rest } = input;
      return { data: { share: await updateShare(shares, caller, share_id, rest) } };
    },
  }),
  defineTool({
    name: "revoke_share",
    title: "Revoke a share link",
    description:
      "Switches a share link off for good: it answers 410 from then on (within 5 minutes for anyone who already opened it). The files are not deleted. Revoking twice is not an error.",
    schema: byShare,
    scope: SCOPE_WRITE,
    destructive: true,
    idempotent: true,
    run: async (input, caller, { shares }) => ({
      data: { share: await revokeShare(shares, caller, input.share_id) },
    }),
  }),
];

import {
  addBrandAssetSchema,
  brandRefSchema,
  createBrandSchema,
  emptySchema,
  removeBrandAssetSchema,
  updateBrandSchema,
} from "../../images/schemas";
import {
  addAsset,
  createBrandKit,
  deleteBrandKit,
  getBrandKit,
  listBrandKits,
  removeAsset,
  updateBrandKit,
} from "../../images/service";
import { serviceFor } from "../context";
import type { ToolDefinition } from "../tool";

export const brandTools: ToolDefinition[] = [
  {
    name: "list_brands",
    title: "List brand kits",
    description:
      "List the account's brand kits with slug, name, palette and how many reference images each has. Call this first to see whether a brand already exists before creating one.",
    schema: emptySchema,
    scope: "images:read",
    run: async (_input, caller) => ({ data: await listBrandKits(await serviceFor(), caller) }),
  } as ToolDefinition,
  {
    name: "get_brand",
    title: "Get a brand kit",
    description:
      "Read one brand kit in full: style prompt, negative prompt, palette, typography, defaults and its reference images (with temporary preview links).",
    schema: brandRefSchema,
    scope: "images:read",
    run: async (input, caller) => ({
      data: await getBrandKit(await serviceFor(), caller, (input as { brand: string }).brand),
    }),
  } as ToolDefinition,
  {
    name: "create_brand",
    title: "Create a brand kit",
    description:
      "Create a brand kit that keeps images consistent. Fill it from what you know about the brand (its website, logo, colours, tone): a style_prompt describing the look in 1-3 sentences (illustration or photo style, mood, layout), a palette of up to 12 hex colours, typography in words, and a negative_prompt for what to avoid. Then add 1-3 reference images with add_brand_asset, because reference images are the strongest consistency tool.",
    schema: createBrandSchema,
    scope: "images:write",
    run: async (input, caller) => ({ data: await createBrandKit(await serviceFor(), caller, input as never) }),
  } as ToolDefinition,
  {
    name: "update_brand",
    title: "Update a brand kit",
    description:
      "Change fields of a brand kit. Only the fields you pass are changed; a palette replaces the whole palette.",
    schema: updateBrandSchema,
    scope: "images:write",
    idempotent: true,
    run: async (input, caller) => ({ data: await updateBrandKit(await serviceFor(), caller, input as never) }),
  } as ToolDefinition,
  {
    name: "add_brand_asset",
    title: "Add a brand reference image",
    description:
      "Store a PNG, JPEG or WebP (max 10 MB) as a private reference for a brand. Pass image_url (a public https link, for example the brand's logo or a good past design) or image_id (an image you already generated, to lock in a winning look). Role is reference (style), logo or example. A brand keeps at most 12; edit_image uses the first ones.",
    schema: addBrandAssetSchema,
    scope: "images:write",
    openWorld: true,
    run: async (input, caller) => ({ data: await addAsset(await serviceFor(), caller, input as never) }),
  } as ToolDefinition,
  {
    name: "remove_brand_asset",
    title: "Remove a brand reference image",
    description: "Remove one reference image from a brand kit and delete its file.",
    schema: removeBrandAssetSchema,
    scope: "images:write",
    destructive: true,
    run: async (input, caller) => {
      const { brand, asset_id } = input as { brand: string; asset_id: string };
      return { data: await removeAsset(await serviceFor(), caller, brand, asset_id) };
    },
  } as ToolDefinition,
  {
    name: "delete_brand",
    title: "Delete a brand kit",
    description:
      "Delete a brand kit and its reference images. Images already generated with it stay available. Ask the user before calling this.",
    schema: brandRefSchema,
    scope: "images:write",
    destructive: true,
    run: async (input, caller) => ({
      data: await deleteBrandKit(await serviceFor(), caller, (input as { brand: string }).brand),
    }),
  } as ToolDefinition,
];

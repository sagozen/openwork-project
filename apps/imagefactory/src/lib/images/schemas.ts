import { z } from "zod";
import { MAX_DIMENSION, MAX_IMAGES_PER_CALL, MIN_DIMENSION } from "./models";
import { PRESET_IDS } from "./presets";

/**
 * Input shapes shared by the MCP tools and the REST API, so both reject the same unknown fields
 * and describe the same arguments. Every object is strict.
 */
const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .describe("Colour as #rrggbb");

export const paletteColorSchema = z
  .object({ name: z.string().min(1).max(40).describe("Role or name, e.g. primary"), hex })
  .strict();

const dimension = z.number().int().min(MIN_DIMENSION).max(MAX_DIMENSION);

const sizeFields = {
  preset: z
    .enum(PRESET_IDS as [string, ...string[]])
    .optional()
    .describe("Size preset. Use list_presets to see sizes and credit costs. Defaults to the brand's preset, else pin."),
  width: dimension.optional().describe("Custom width in pixels. Give both width and height, or use a preset."),
  height: dimension.optional().describe("Custom height in pixels."),
};

const commonImageFields = {
  brand: z
    .string()
    .max(80)
    .optional()
    .describe("Brand kit slug or id. Applies its style, palette and negative prompt."),
  text: z
    .string()
    .max(120)
    .optional()
    .describe("Exact text to print on the image. Keep it short (a few words); long text is often misspelled."),
  variation: z.string().max(300).optional().describe("Extra direction for this one image in a series."),
  num_images: z.number().int().min(1).max(MAX_IMAGES_PER_CALL).default(1).describe("Images to make, 1 to 4."),
  seed: z.number().int().min(0).max(2_147_483_647).optional().describe("Fixed seed to reproduce or remix a result."),
  negative_prompt: z.string().max(500).optional().describe("Things to avoid, added to the brand's negative prompt."),
  title: z.string().max(120).optional().describe("Short label stored with the image."),
  tags: z.array(z.string().max(40)).max(10).optional().describe("Tags stored with the image."),
};

export const generateImageSchema = z
  .object({
    prompt: z.string().min(1).max(2000).describe("What the image shows."),
    ...commonImageFields,
    ...sizeFields,
    model: z.enum(["qwen-image"]).optional(),
  })
  .strict();

export const editImageSchema = z
  .object({
    instruction: z.string().min(1).max(2000).describe("What to change or make, in plain words."),
    image_ids: z.array(z.string().min(1).max(60)).max(3).optional().describe("ImageFactory image ids to edit."),
    image_urls: z.array(z.url().max(2000)).max(3).optional().describe("Public https image URLs to edit."),
    ...commonImageFields,
    ...sizeFields,
  })
  .strict();

export const estimateCostSchema = z
  .object({
    ...sizeFields,
    num_images: commonImageFields.num_images,
    mode: z.enum(["generate", "edit"]).default("generate"),
  })
  .strict();

const brandFields = {
  description: z.string().max(500).optional(),
  style_prompt: z
    .string()
    .max(1500)
    .optional()
    .describe("Style direction added to every prompt: mood, layout, illustration or photo style."),
  negative_prompt: z.string().max(500).optional(),
  palette: z.array(paletteColorSchema).max(12).optional(),
  typography: z.string().max(300).optional().describe("Type direction in words, e.g. bold rounded sans-serif titles."),
  default_model: z.enum(["qwen-image", "qwen-edit"]).optional(),
  default_preset: z.enum(PRESET_IDS as [string, ...string[]]).optional(),
};

export const createBrandSchema = z.object({ name: z.string().min(1).max(80), ...brandFields }).strict();
export const updateBrandSchema = z
  .object({ brand: z.string().min(1).max(80), name: z.string().min(1).max(80).optional(), ...brandFields })
  .strict();
export const brandRefSchema = z.object({ brand: z.string().min(1).max(80).describe("Brand slug or id") }).strict();
export const addBrandAssetSchema = z
  .object({
    brand: z.string().min(1).max(80),
    image_url: z.url().max(2000).optional().describe("Public https URL of a PNG, JPEG or WebP"),
    image_id: z.string().max(60).optional().describe("An ImageFactory image id from this account"),
    role: z.enum(["reference", "logo", "example"]).default("reference"),
    note: z.string().max(200).optional(),
  })
  .strict();
export const removeBrandAssetSchema = z
  .object({ brand: z.string().min(1).max(80), asset_id: z.string().min(1).max(60) })
  .strict();

export const listImagesSchema = z
  .object({
    brand: z.string().max(80).optional(),
    tag: z.string().max(40).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().max(200).optional().describe("Cursor from the previous page"),
  })
  .strict();
export const imageRefSchema = z.object({ image_id: z.string().min(1).max(60) }).strict();
export const jobRefSchema = z.object({ job_id: z.string().min(1).max(60) }).strict();
export const emptySchema = z.object({}).strict();

export type GenerateImageInput = z.infer<typeof generateImageSchema>;
export type EditImageInput = z.infer<typeof editImageSchema>;
export type EstimateCostInput = z.infer<typeof estimateCostSchema>;
export type CreateBrandInput = z.infer<typeof createBrandSchema>;
export type UpdateBrandInput = z.infer<typeof updateBrandSchema>;
export type AddBrandAssetInput = z.infer<typeof addBrandAssetSchema>;
export type ListImagesInput = z.infer<typeof listImagesSchema>;

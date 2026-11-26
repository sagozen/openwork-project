import {
  editImageSchema,
  generateImageSchema,
  imageRefSchema,
  jobRefSchema,
  listImagesSchema,
} from "../../images/schemas";
import {
  deleteImageById,
  editImages,
  generateImages,
  getImageDetail,
  getJobResult,
  listImages,
  loadPreviews,
} from "../../images/service";
import { serviceFor } from "../context";
import { generationResult } from "../result";
import type { ToolDefinition } from "../tool";

export const imageTools: ToolDefinition[] = [
  {
    name: "generate_image",
    title: "Generate images",
    description:
      "Make 1-4 new images from a text prompt. Pass brand (a slug from list_brands) to apply that brand's style, palette and negative prompt. Pick a preset: pin (Pinterest 2:3), pin_hd, square, blog_hero (16:9, also good for OG images) or cover_6x9 (book cover concept); list_presets shows sizes and credit costs. Each image costs credits and the price is shown by estimate_cost. Put any words that must appear on the image in text and keep them to a few words; diffusion models misspell long text. The reply has a public URL for each image that works in Pinterest, a blog or n8n. To make variations of a good result, call edit_image with its image id or reuse its seed.",
    schema: generateImageSchema,
    scope: "images:write",
    openWorld: true,
    run: async (input, caller) => {
      const deps = await serviceFor();
      const result = await generateImages(deps, caller, input as never);
      return { reply: generationResult(result, await loadPreviews(deps, caller, result.images)) };
    },
  } as ToolDefinition,
  {
    name: "edit_image",
    title: "Edit or vary images",
    description:
      "Make new images from existing ones: change a generated image, make a variation in the same style, or create a new design that matches a brand's reference images. Give image_ids (images from this account) and/or image_urls (public https links), plus an instruction in plain words. Pass brand to add the brand's reference images so the result follows its style. Up to 3 reference images in total. Costs more than generate_image per megapixel.",
    schema: editImageSchema,
    scope: "images:write",
    openWorld: true,
    run: async (input, caller) => {
      const deps = await serviceFor();
      const result = await editImages(deps, caller, input as never);
      return { reply: generationResult(result, await loadPreviews(deps, caller, result.images)) };
    },
  } as ToolDefinition,
  {
    name: "get_job",
    title: "Check a job",
    description:
      "Check an image job that generate_image or edit_image reported as still running. Returns the images when it is done. Credits are only charged for delivered images.",
    schema: jobRefSchema,
    scope: "images:read",
    run: async (input, caller) => {
      const deps = await serviceFor();
      const result = await getJobResult(deps, caller, (input as { job_id: string }).job_id);
      return { reply: generationResult(result, await loadPreviews(deps, caller, result.images)) };
    },
  } as ToolDefinition,
  {
    name: "list_images",
    title: "List images",
    description: "List the account's recent images, newest first. Filter by brand or tag; follow next_cursor for more.",
    schema: listImagesSchema,
    scope: "images:read",
    run: async (input, caller) => ({ data: await listImages(await serviceFor(), caller, input as never) }),
  } as ToolDefinition,
  {
    name: "get_image",
    title: "Get an image",
    description:
      "Read one image's details: public URL, size, seed, the exact prompt that was sent, brand and references. Use the seed and prompt to remix it.",
    schema: imageRefSchema,
    scope: "images:read",
    run: async (input, caller) => ({
      data: await getImageDetail(await serviceFor(), caller, (input as { image_id: string }).image_id),
    }),
  } as ToolDefinition,
  {
    name: "delete_image",
    title: "Delete an image",
    description:
      "Delete an image. Its public URL stops working immediately. Ask the user before calling this, because the image may already be published somewhere.",
    schema: imageRefSchema,
    scope: "images:write",
    destructive: true,
    run: async (input, caller) => ({
      data: await deleteImageById(await serviceFor(), caller, (input as { image_id: string }).image_id),
    }),
  } as ToolDefinition,
];

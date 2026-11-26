import { z } from "zod";
import {
  createUploadSchema,
  downloadLinkSchema,
  importFromUrlSchema,
  listArtifactsSchema,
  putInlineSchema,
  setExpirySchema,
} from "../../artifacts/schemas";
import {
  completeUpload,
  createUpload,
  deleteArtifact,
  downloadLink,
  getArtifact,
  importFromUrl,
  listArtifacts,
  putInline,
  readContent,
  setExpiry,
  usage,
} from "../../artifacts/service";
import { SCOPE_READ, SCOPE_WRITE } from "../../auth/scopes";
import { ARTIFACT_ID_PATTERN } from "../../storage/keys";
import { imageFileResult, textFileResult } from "../result";
import { defineTool, type ToolDefinition } from "../tool";

const fileId = z.string().regex(ARTIFACT_ID_PATTERN, "Not a valid file id. Use an id from list_files.");
const byFile = z.object({ file_id: fileId }).strict();
const empty = z.object({}).strict();

export const SIZE_HINT = "about 4 MB";

export const fileTools: ToolDefinition[] = [
  defineTool({
    name: "list_files",
    title: "List files",
    description:
      "List stored files, newest first. Filter by name with query, and page with the next_cursor from the previous reply. Status defaults to ready; use pending for uploads that were created but not completed.",
    schema: listArtifactsSchema,
    scope: SCOPE_READ,
    run: async (input, caller, { artifacts }) => ({ data: { ...(await listArtifacts(artifacts, caller, input)) } }),
  }),
  defineTool({
    name: "get_file",
    title: "Get a file's details",
    description: "Name, type, size, checksum, expiry and status of one file. Does not return its content.",
    schema: byFile,
    scope: SCOPE_READ,
    run: async (input, caller, { artifacts }) => ({
      data: { file: await getArtifact(artifacts, caller, input.file_id) },
    }),
  }),
  defineTool({
    name: "read_file",
    title: "Read a file's content",
    description:
      "Read a small file so you can use what is in it: text files up to 1 MB come back as text and images up to 4 MB as an image. For anything else, or anything bigger, use get_download_link and give the user the link.",
    schema: byFile,
    scope: SCOPE_READ,
    run: async (input, caller, { artifacts }) => {
      const content = await readContent(artifacts, caller, input.file_id);
      return { reply: content.kind === "text" ? textFileResult(content) : imageFileResult(content) };
    },
  }),
  defineTool({
    name: "get_download_link",
    title: "Get a temporary download link",
    description:
      "A presigned link to view or download one file, valid from 1 minute to 7 days (default 1 hour). It cannot be revoked before it expires; for a long-lived, revocable, optionally password-protected link use create_share instead. Files a browser could run (HTML, SVG) always download. Show the user the URL.",
    schema: downloadLinkSchema.extend({ file_id: fileId }),
    scope: SCOPE_READ,
    run: async (input, caller, { artifacts }) => {
      const { file_id, ...options } = input;
      return { data: { ...(await downloadLink(artifacts, caller, file_id, options)) } };
    },
  }),
  defineTool({
    name: "get_usage",
    title: "Get storage usage",
    description: "How many files are stored and how many bytes they use in total.",
    schema: empty,
    scope: SCOPE_READ,
    run: async (_input, caller, { artifacts }) => ({ data: { ...(await usage(artifacts, caller)) } }),
  }),
  defineTool({
    name: "create_upload",
    title: "Start an upload with a presigned URL",
    description:
      "Use when you can make HTTP requests (a shell, n8n, a script) and the file is big or binary. Declare the name and exact size in bytes; you get an upload_url. PUT exactly that many bytes to it with the returned headers (for example curl -T file -H 'content-type: ...' URL), then call complete_upload with the file_id. The URL works for 15 minutes and only for that size and type. Up to 5 GB.",
    schema: createUploadSchema,
    scope: SCOPE_WRITE,
    run: async (input, caller, { artifacts }) => {
      const { artifact_id, ...rest } = await createUpload(artifacts, caller, input);
      return {
        data: {
          file_id: artifact_id,
          ...rest,
          next_step: `PUT exactly ${rest.content_length} bytes to upload_url with the headers above, then call complete_upload with this file_id.`,
        },
      };
    },
  }),
  defineTool({
    name: "complete_upload",
    title: "Finish an upload",
    description:
      "Call after PUTting the bytes to the upload_url from create_upload. Checks the stored object, records its real size and makes the file ready. Safe to call again.",
    schema: byFile,
    scope: SCOPE_WRITE,
    idempotent: true,
    run: async (input, caller, { artifacts }) => ({
      data: { file: await completeUpload(artifacts, caller, input.file_id) },
    }),
  }),
  defineTool({
    name: "put_file",
    title: "Save a small file from content",
    description: `Use for small content you have in the conversation (a note, JSON, CSV, a small image): pass it as text, or as base64 with encoding "base64". Limit ${SIZE_HINT} decoded; for bigger files use create_upload when you can make HTTP requests, or import_from_url for a public link.`,
    schema: putInlineSchema,
    scope: SCOPE_WRITE,
    run: async (input, caller, { artifacts }) => ({
      data: { file: await putInline(artifacts, caller, input) },
    }),
  }),
  defineTool({
    name: "import_from_url",
    title: "Save a file from a public URL",
    description:
      "Fetches a public https URL and stores the file (up to 100 MB; only https, standard port, no private addresses, at most 3 redirects). Use when the file already has a public link and you cannot or should not download it yourself.",
    schema: importFromUrlSchema,
    scope: SCOPE_WRITE,
    openWorld: true,
    run: async (input, caller, { artifacts }) => ({
      data: { file: await importFromUrl(artifacts, caller, input) },
    }),
  }),
  defineTool({
    name: "set_file_expiry",
    title: "Set or clear a file's expiry",
    description:
      "Files are kept until deleted. Set expires_in_days to have the file removed after that many days (counted from now), or null to keep it. An expired file stops working in links and shares.",
    schema: setExpirySchema.extend({ file_id: fileId }),
    scope: SCOPE_WRITE,
    idempotent: true,
    run: async (input, caller, { artifacts }) => {
      const { file_id, ...rest } = input;
      return { data: { file: await setExpiry(artifacts, caller, file_id, rest) } };
    },
  }),
  defineTool({
    name: "delete_file",
    title: "Delete a file",
    description:
      "Permanently deletes the stored file and removes it from every share. Cannot be undone. Deleting a file that is already deleted is not an error.",
    schema: byFile,
    scope: SCOPE_WRITE,
    destructive: true,
    idempotent: true,
    run: async (input, caller, { artifacts }) => ({
      data: { ...(await deleteArtifact(artifacts, caller, input.file_id)) },
    }),
  }),
];

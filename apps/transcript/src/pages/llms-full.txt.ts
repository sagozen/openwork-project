import { docsPlainText } from "@templatedesign/platform/docs-markdown";
import type { APIRoute } from "astro";
import raw from "../content/docs.md?raw";
import { docsSource } from "../lib/docs";

/** The whole `/docs` page as Markdown, for agents that read one URL. */
export const GET: APIRoute = () =>
  new Response(docsPlainText(docsSource(raw)), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });

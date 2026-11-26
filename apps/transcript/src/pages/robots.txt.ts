import type { APIRoute } from "astro";

export const GET: APIRoute = async () => {
  const body = `User-agent: *
Allow: /
Disallow: /admin
Disallow: /api

Sitemap: https://transcriptanything.zhst.app/sitemap.xml
`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
};

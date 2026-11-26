import type { APIRoute } from "astro";
import { invoke, rest } from "../../../lib/api/rest";

export const prerender = false;

export const GET: APIRoute = (context) =>
  rest(context, (caller, services) => invoke("get_usage", {}, caller, services));

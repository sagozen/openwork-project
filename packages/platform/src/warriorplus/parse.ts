import { HttpError } from "../http";
import type { IpnPayload } from "./types";

export const IPN_MAX_BYTES = 64 * 1024;

/**
 * Parse a WarriorPlus IPN. The documented wire format is multipart/form-data; urlencoded is
 * accepted defensively. Every value is a string, and unknown fields are kept rather than
 * rejected because WarriorPlus may add legacy PayPal fields.
 */
export async function parseIpn(request: Request): Promise<IpnPayload> {
  if (request.method !== "POST") {
    throw new HttpError("invalid_input", 405, "WarriorPlus IPNs are POST requests.");
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > IPN_MAX_BYTES) {
    throw new HttpError("payload_too_large", 413, "The IPN body is too large.");
  }
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const payload: IpnPayload = {};

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") payload[key.toUpperCase()] = value;
    }
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = await request.text();
    if (body.length > IPN_MAX_BYTES) {
      throw new HttpError("payload_too_large", 413, "The IPN body is too large.");
    }
    for (const [key, value] of new URLSearchParams(body)) {
      payload[key.toUpperCase()] = value;
    }
  } else {
    throw new HttpError("invalid_input", 415, "The IPN must be multipart/form-data.");
  }

  if (Object.keys(payload).length === 0) {
    throw new HttpError("invalid_input", 400, "The IPN body is empty.");
  }
  return payload;
}

export function pick(payload: IpnPayload, ...names: string[]): string {
  for (const name of names) {
    const value = payload[name.toUpperCase()];
    if (value !== undefined) return value;
  }
  return "";
}

/** Constant-time comparison for the shared static key and its rotation sibling. */
export function constantTimeEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/** Remove the secret before a payload is stored, logged or replayed. */
export function stripSecret(payload: IpnPayload): IpnPayload {
  const copy: IpnPayload = { ...payload };
  delete copy.WP_SECURITYKEY;
  return copy;
}

export function amountCents(value: string): number | null {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
}

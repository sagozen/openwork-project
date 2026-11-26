import { describe, expect, test } from "bun:test";
import { CLERK_KEY, resolveClerkDomain } from "../src/lib/auth/clerk-domains";

function frontendApiHost(key: string): string {
  return atob(key.slice("pk_live_".length)).replace(/\$$/, "");
}

describe("Clerk production domain", () => {
  test("uses the provisioned DLP LIMS Frontend API", () => {
    expect(frontendApiHost(CLERK_KEY)).toBe("clerk.auth-dlp.pandev00.com");
    expect(resolveClerkDomain("lims.dalienphat.com")).not.toBeNull();
  });
});

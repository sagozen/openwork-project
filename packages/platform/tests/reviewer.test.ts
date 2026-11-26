import assert from "node:assert/strict";
import test from "node:test";
import { isReviewerSignIn, reviewerEmail } from "../src/reviewer";

test("reviewer sign-in is off unless a valid email is configured", () => {
  assert.equal(reviewerEmail({}), null);
  assert.equal(reviewerEmail({ REVIEWER_EMAIL: "" }), null);
  assert.equal(reviewerEmail({ REVIEWER_EMAIL: "not-an-email" }), null);
  assert.equal(reviewerEmail({ REVIEWER_EMAIL: "  Reviewer@Example.com " }), "reviewer@example.com");
});

test("only the configured reviewer email may attempt a password sign-in", () => {
  const reviewer = "reviewer@example.com";
  assert.equal(isReviewerSignIn("Reviewer@Example.com ", reviewer), true);
  assert.equal(isReviewerSignIn("buyer@example.com", reviewer), false);
  assert.equal(isReviewerSignIn("reviewer@example.com.evil.test", reviewer), false);
  assert.equal(isReviewerSignIn(undefined, reviewer), false);
  assert.equal(isReviewerSignIn(["reviewer@example.com"], reviewer), false);
});

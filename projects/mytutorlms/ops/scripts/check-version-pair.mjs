#!/usr/bin/env node
// Fails when the theme and plugin versions differ: only matched pairs may be deployed.
import { readFileSync } from "node:fs";

const read = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const theme = JSON.parse(read("themes/mytutor/package.json")).version;
const plugin = JSON.parse(read("plugins/mytutor-lms/package.json")).version;
const declared = /export const VERSION = "([^"]+)"/.exec(
  read("plugins/mytutor-lms/src/index.ts"),
)?.[1];
if (theme !== plugin || plugin !== declared) {
  console.error(
    `Version mismatch: theme ${theme}, plugin package ${plugin}, plugin VERSION ${declared}.`,
  );
  process.exit(1);
}
console.log(`Matched pair ${theme}.`);

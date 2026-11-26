#!/usr/bin/env node
/**
 * Phase 1 contract linter.
 *
 * - every JSON Schema is a valid 2020-12 schema
 * - fixtures validate (valid fixtures pass, invalid fixtures fail for the right reasons)
 * - cross-field rules that JSON Schema cannot express are enforced
 * - the OpenAPI document parses, every $ref resolves, every operation is described
 * - the error catalogue, the Problem enum and the analytics allowlist agree
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = async (path) => JSON.parse(await readFile(join(root, path), "utf8"));

const failures = [];
const fail = (message) => failures.push(message);
const ok = (message) => console.log(`  ok  ${message}`);

/* ----------------------------------------------------------- schemas */

const schemaDir = join(root, "schemas");
const schemaFiles = (await readdir(schemaDir)).filter((file) => file.endsWith(".schema.json"));
const schemas = new Map();
for (const file of schemaFiles) {
  const schema = JSON.parse(await readFile(join(schemaDir, file), "utf8"));
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    fail(`${file}: must declare JSON Schema 2020-12`);
  }
  if (!schema.$id) fail(`${file}: missing $id`);
  schemas.set(file, schema);
}

const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);
for (const schema of schemas.values()) ajv.addSchema(schema);

const validators = new Map();
for (const [file, schema] of schemas) {
  try {
    validators.set(file, ajv.getSchema(schema.$id) ?? ajv.compile(schema));
  } catch (error) {
    fail(`${file}: ${error.message}`);
  }
}
ok(`${schemas.size} JSON Schemas compile`);

const validate = (file, data) => {
  const validator = validators.get(file);
  if (!validator) throw new Error(`No validator for ${file}`);
  const valid = validator(data);
  return { valid, errors: validator.errors ?? [] };
};

/* ---------------------------------------------------------- fixtures */

const fixtures = [
  { schema: "certificate-input.schema.json", file: "certificate-en.json", valid: true },
  { schema: "certificate-input.schema.json", file: "certificate-vi.json", valid: true },
  { schema: "certificate-input.schema.json", file: "certificate-invalid.json", valid: false },
  { schema: "cfo-input.schema.json", file: "cfo-valid.json", valid: true },
  { schema: "cfo-input.schema.json", file: "cfo-mixed-currency.json", valid: false, rule: "mixed-currency" },
  { schema: "template-profile.schema.json", file: "profile-certificate-valid.json", valid: true },
  { schema: "template-profile.schema.json", file: "profile-invalid.json", valid: false },
];

/**
 * Business rules that JSON Schema cannot express. They are part of the server
 * contract and must be tested alongside structure.
 */
function businessRuleErrors(schemaFile, data) {
  const errors = [];
  if (schemaFile === "cfo-input.schema.json") {
    if (data.report && data.totals && Array.isArray(data.services)) {
      const currencies = new Set(data.services.map((row) => row.currency ?? data.report.currency));
      if (currencies.size > 1 && !data.fx) {
        errors.push("mixed currency rows require an fx object");
      }
      if (data.reconciliation !== "show_unallocated") {
        const sum = data.services.reduce((total, row) => total + (row.actual_minor ?? 0), 0);
        if (sum !== data.totals.current_minor) {
          errors.push(`services sum ${sum} != totals.current_minor ${data.totals.current_minor}`);
        }
      }
      if (data.report.period_start && data.report.period_end && data.report.period_start > data.report.period_end) {
        errors.push("period_start is after period_end");
      }
    }
  }
  if (schemaFile === "template-profile.schema.json") {
    for (const page of data.source?.schemas ?? []) {
      for (const element of page) {
        if (typeof element.content === "string" && /\{[^}]*\}/.test(element.content)) {
          errors.push(`expression syntax in element "${element.name}"`);
        }
        if (element.td?.fit?.policy === "shrink" && element.td?.fit?.min > 72) {
          errors.push(`element "${element.name}" shrink minimum is above 72pt`);
        }
      }
    }
  }
  return errors;
}

for (const fixture of fixtures) {
  const data = await readJson(`fixtures/${fixture.file}`);
  const result = validate(fixture.schema, data);
  const rules = businessRuleErrors(fixture.schema, data);
  const actualValid = result.valid && rules.length === 0;
  if (actualValid !== fixture.valid) {
    fail(
      `${fixture.file}: expected ${fixture.valid ? "valid" : "invalid"}, got ${actualValid ? "valid" : "invalid"} (${[
        ...result.errors.slice(0, 3).map((error) => `${error.instancePath || "/"} ${error.message}`),
        ...rules,
      ].join("; ")})`,
    );
    continue;
  }
  ok(`${fixture.file} ${fixture.valid ? "valid" : "rejected"} as expected`);
}

/* ----------------------------------------------- cross-field rules */

const cfo = await readJson("fixtures/cfo-valid.json");
const cfoRules = businessRuleErrors("cfo-input.schema.json", cfo);
if (cfoRules.length > 0) fail(`cfo-valid.json: ${cfoRules.join("; ")}`);
else ok("cfo-valid.json satisfies reconciliation and currency rules");

const mixed = await readJson("fixtures/cfo-mixed-currency.json");
const mixedRules = businessRuleErrors("cfo-input.schema.json", mixed);
if (mixedRules.some((message) => message.includes("mixed currency"))) {
  ok("cfo-mixed-currency.json rejected by the mixed-currency rule");
} else {
  fail("cfo-mixed-currency.json should require an fx object");
}

const profile = await readJson("fixtures/profile-certificate-valid.json");
for (const page of profile.source.schemas) {
  for (const element of page) {
    if (typeof element.content === "string" && /\{[^}]*\}/.test(element.content)) {
      fail(`profile-certificate-valid.json: expression syntax in element "${element.name}"`);
    }
  }
}
ok("valid profile has no expression syntax");

/* --------------------------------------------------------------- errors */

const errors = await readJson("catalogue/errors.json");
const errorCodes = errors.codes.map((entry) => entry.code);
if (new Set(errorCodes).size !== errorCodes.length) fail("errors.json: duplicate codes");
for (const entry of errors.codes) {
  if (!entry.title?.en || !entry.title?.vi) fail(`errors.json: ${entry.code} missing EN/VI title`);
  if (!entry.detail?.en || !entry.detail?.vi) fail(`errors.json: ${entry.code} missing EN/VI detail`);
  if (!Number.isInteger(entry.http)) fail(`errors.json: ${entry.code} has no HTTP status`);
}
const problemSchema = schemas.get("problem.schema.json");
const problemEnum = problemSchema.properties.code.enum;
if (JSON.stringify(problemEnum) !== JSON.stringify(errorCodes)) {
  fail("problem.schema.json code enum does not match catalogue/errors.json");
}
ok(`${errorCodes.length} error codes agree across catalogue and Problem schema`);

/* ------------------------------------------------------------ analytics */

const analytics = await readJson("catalogue/analytics-events.json");
const names = analytics.events.map((event) => event.name);
if (new Set(names).size !== names.length) fail("analytics-events.json: duplicate event names");
for (const event of analytics.events) {
  for (const prop of event.props) {
    if (analytics.forbiddenProperties.includes(prop))
      fail(`analytics-events.json: ${event.name} allows forbidden property ${prop}`);
  }
}
ok(`${names.length} analytics events allowlisted`);

/* -------------------------------------------------------------- OpenAPI */

const openapi = YAML.parse(await readFile(join(root, "openapi", "openapi.yaml"), "utf8"));
if (openapi.openapi !== "3.1.0") fail("openapi.yaml: must be OpenAPI 3.1.0");
if (!openapi.paths || Object.keys(openapi.paths).length === 0) fail("openapi.yaml: no paths");

function resolveRef(ref) {
  if (!ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .reduce((node, part) => node?.[part.replaceAll("~1", "/").replaceAll("~0", "~")], openapi);
}

let refCount = 0;
let operationCount = 0;
for (const [path, item] of Object.entries(openapi.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
    operationCount += 1;
    if (!operation.operationId) fail(`openapi.yaml: ${method.toUpperCase()} ${path} has no operationId`);
    if (!operation.responses || Object.keys(operation.responses).length === 0) {
      fail(`openapi.yaml: ${method.toUpperCase()} ${path} has no responses`);
    }
  }
}
const walk = (node) => {
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      refCount += 1;
      if (!resolveRef(value)) fail(`openapi.yaml: unresolved $ref ${value}`);
    } else {
      walk(value);
    }
  }
};
walk(openapi);
const openapiProblem = openapi.components.schemas.Problem.properties.code.enum;
if (JSON.stringify(openapiProblem) !== JSON.stringify(errorCodes)) {
  fail("openapi.yaml Problem enum does not match the error catalogue");
}
if (openapi.components.schemas.Job.properties.status.enum.join() !== "queued,running,succeeded,failed,cancelled") {
  fail("openapi.yaml Job status enum changed without updating the job schema");
}
ok(`${operationCount} operations, ${refCount} refs validated`);

/* -------------------------------------------------------------- result */

if (failures.length > 0) {
  console.error(`\ncontracts: ${failures.length} failure(s)`);
  for (const message of failures) console.error(`  FAIL ${message}`);
  process.exit(1);
}
console.log("\ncontracts: all checks pass");

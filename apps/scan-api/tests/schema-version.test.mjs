import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { REQUIRED_SCHEMA_VERSION } from "../src/schema-version.mjs";

test("readiness requires the latest checked-in migration", async () => {
  const migrationUrl = new URL("../migrations/", import.meta.url);
  const migrations = (await readdir(migrationUrl))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  assert.ok(migrations.length > 0, "at least one migration is required");
  assert.equal(REQUIRED_SCHEMA_VERSION, migrations.at(-1));
});

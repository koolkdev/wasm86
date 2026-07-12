import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { LegacyHelperIndexRegistryAdapter } from "#wasm/helpers/registry.js";

test("resolved helper bindings provide numeric function indexes", () => {
  const bound = { kind: "lazyFlag", flag: "CF" } as const;
  const missing = { kind: "lazyFlag", flag: "ZF" } as const;
  const registry = new LegacyHelperIndexRegistryAdapter([{ key: bound, functionIndex: 7 }]);

  strictEqual(registry.functionIndex(bound), 7);
  strictEqual(registry.functionIndex(missing), undefined);
});

test("resolved helper bindings reject duplicate keys", () => {
  throws(
    () => new LegacyHelperIndexRegistryAdapter(
      [
        { key: { kind: "lazyFlag", flag: "CF" }, functionIndex: 1 },
        { key: { kind: "lazyFlag", flag: "CF" }, functionIndex: 2 }
      ]
    ),
    /duplicate Wasm helper index binding: resolveCF/
  );
});

test("resolved helper bindings reject invalid numeric indexes", () => {
  throws(
    () => new LegacyHelperIndexRegistryAdapter(
      [{ key: { kind: "lazyFlag", flag: "CF" }, functionIndex: -1 }]
    ),
    /invalid Wasm helper function index for resolveCF: -1/
  );
});

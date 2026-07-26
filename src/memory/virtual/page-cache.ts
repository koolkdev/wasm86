import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import type { PageTableAccess } from "./page-table.js";

export function createCachedPageTableAccess(
  root: RegionBuilder,
  source: PageTableAccess
): PageTableAccess {
  // Function locals reset between invocations, when the host may have changed
  // mappings. Within one invocation the page-table resource is read-only.
  const cachedPage = root.variable(root.values.const(-1));
  const cachedEntry = root.variable(root.values.const(0));

  return {
    effect: source.effect,
    read: (region, page) => {
      const hit = region.values.compare(
        32,
        "eq",
        page,
        region.read(cachedPage)
      );

      return region.ifValue(
        hit,
        (cached) => cached.read(cachedEntry),
        (miss) => {
          const entry = source.read(miss, page);

          miss.write(cachedEntry, entry);
          miss.write(cachedPage, page);
          return entry;
        },
        { hint: "likely" }
      );
    }
  };
}

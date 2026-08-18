import type { RegionBuilder } from "#compiler/function/builder/region.js";
import { i32 } from "#compiler/function/values.js";
import type { PageTableAccess } from "./page-table.js";

export function createCachedPageTableAccess(
  root: RegionBuilder,
  source: PageTableAccess
): PageTableAccess {
  // Function locals reset between invocations, when the host may have changed
  // mappings. Within one invocation the page-table resource is read-only.
  const cachedPage = root.variable(i32(-1));
  const cachedEntry = root.variable(i32(0));

  return {
    effect: source.effect,
    read: (region, page) => {
      const hit = page.eq(region.read(cachedPage));

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

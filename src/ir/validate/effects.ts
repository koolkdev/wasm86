import { assert } from "#common/assert.js";
import type {
  StorageAccess,
  StorageEffects
} from "#compiler/ir/effects.js";
import { validateResourceEffect } from "./resource.js";

// Declared function effects are consumed directly by liveness and alias
// analysis before a callee body need be built. Validate the retained summary
// at its declaration boundary rather than trusting its TypeScript shape.
export function validateDeclaredStorageEffects(
  effects: StorageEffects,
  label: string
): void {
  assert(effects !== undefined && effects !== null, `${label} is missing its effects`);
  assert(
    Array.isArray(effects.reads) && Array.isArray(effects.writes),
    `${label} effects must contain read and write arrays`
  );

  validateDeclaredAccesses(effects.reads, "read", label);
  validateDeclaredAccesses(effects.writes, "write", label);
}

function validateDeclaredAccesses(
  accesses: readonly StorageAccess[],
  direction: "read" | "write",
  label: string
): void {
  for (const [index, access] of accesses.entries()) {
    assert(
      access !== undefined && access !== null && typeof access === "object",
      `${label} ${direction} effect ${index} must be a storage effect`
    );

    switch (access.space) {
      case "state":
      case "cell":
        break;
      case "resource":
        validateResourceEffect(
          access,
          `${label} ${direction} effect ${index}`
        );
        break;
      default:
        assert(false, `${label} ${direction} effect ${index} has an unknown space`);
    }
  }
}

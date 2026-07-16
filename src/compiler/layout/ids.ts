import { assert } from "#common/assert.js";

const idPattern = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const scopedIdPattern = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;

export function assertId(id: string, kind: string): void {
  assert(idPattern.test(id), `${kind} must be a stable id: ${id}`);
}

export function assertScopedId(id: string, kind: string): void {
  assert(
    scopedIdPattern.test(id),
    `${kind} must be a stable namespaced id: ${id}`
  );
}

export function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

import type { LayoutMember } from "./handles.js";

export type LayoutStructure = Readonly<{
  id: string;
  members: readonly LayoutMember[];
}>;

export function layoutStructure(id: string, members: readonly LayoutMember[]): LayoutStructure {
  return { id, members };
}

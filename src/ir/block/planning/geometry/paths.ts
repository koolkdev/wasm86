import type {
  Path,
  PathGeometry
} from "./types.js";

export function pathCovers(
  tree: PathGeometry,
  candidate: Path,
  observed: Path
): boolean {
  if (candidate === observed) {
    return true;
  }

  let current = observed;
  const seen = new Set<Path>();

  while (!seen.has(current)) {
    seen.add(current);

    const parent = tree.parentByPath.get(current);

    if (parent === undefined) {
      return false;
    }

    if (parent === candidate) {
      return true;
    }

    current = parent;
  }

  return false;
}

export function pathsInTree(tree: PathGeometry): readonly Path[] {
  const paths: Path[] = [tree.root];

  for (const edge of tree.edges) {
    paths.push(edge.child);
  }

  return Object.freeze(paths);
}

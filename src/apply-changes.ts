import type { GraphChange, GraphSnapshot } from "./types.js";

/**
 * Applies changes emitted by a graph to a snapshot, in place, and returns it.
 * Useful for stores that keep the whole graph as one document (e.g. a JSON
 * file): load the document, apply each batch, write it back.
 */
export function applyChanges<T>(
  snapshot: GraphSnapshot<T>,
  changes: Iterable<GraphChange<T>>,
): GraphSnapshot<T> {
  for (const change of changes) {
    switch (change.type) {
      case "node-added":
        snapshot.nodes.push({ ...change.node });
        break;
      case "node-updated": {
        const index = snapshot.nodes.findIndex((node) => node.id === change.node.id);
        if (index >= 0) {
          snapshot.nodes[index] = { ...change.node };
        }
        break;
      }
      case "node-removed":
        snapshot.nodes = snapshot.nodes.filter((node) => node.id !== change.id);
        break;
      case "dependency-added":
        snapshot.dependencies.push({ id: change.id, dependsOn: change.dependsOn });
        break;
      case "dependency-removed":
        snapshot.dependencies = snapshot.dependencies.filter(
          (edge) => edge.id !== change.id || edge.dependsOn !== change.dependsOn,
        );
        break;
    }
  }
  return snapshot;
}

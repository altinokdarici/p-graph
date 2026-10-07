import type { DependencyRecord, GraphChange, GraphSnapshot, NodeId } from "./types.js";

/**
 * Applies changes emitted by a graph to a snapshot, in place, and returns it.
 * Useful for stores that keep the whole graph as one document (e.g. a JSON
 * file): load the document, apply each batch, write it back.
 */
export function applyChanges<T, E = undefined>(
  snapshot: GraphSnapshot<T, E>,
  changes: Iterable<GraphChange<T, E>>,
): GraphSnapshot<T, E> {
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
        snapshot.dependencies.push(toEdge(change.id, change.dependsOn, change.data));
        break;
      case "dependency-updated": {
        const index = snapshot.dependencies.findIndex(
          (edge) => edge.id === change.id && edge.dependsOn === change.dependsOn,
        );
        if (index >= 0) {
          snapshot.dependencies[index] = toEdge(change.id, change.dependsOn, change.data);
        }
        break;
      }
      case "dependency-removed":
        snapshot.dependencies = snapshot.dependencies.filter(
          (edge) => edge.id !== change.id || edge.dependsOn !== change.dependsOn,
        );
        break;
    }
  }
  return snapshot;
}

function toEdge<E>(id: NodeId, dependsOn: NodeId, data: E | undefined): DependencyRecord<E> {
  return data === undefined ? { id, dependsOn } : { id, dependsOn, data };
}

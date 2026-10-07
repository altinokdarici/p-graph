import type { NodeId, NodeState } from "./types.js";

/** Base class for every error thrown by this library. */
export class PriorityGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown when an operation references a node that does not exist. */
export class NodeNotFoundError extends PriorityGraphError {
  constructor(readonly id: NodeId) {
    super(`Node "${id}" does not exist.`);
  }
}

/** Thrown when an operation references a dependency edge that does not exist. */
export class DependencyNotFoundError extends PriorityGraphError {
  constructor(
    readonly id: NodeId,
    readonly dependsOn: NodeId,
  ) {
    super(`Node "${id}" does not depend on "${dependsOn}".`);
  }
}

/** Thrown when adding a node whose id is already in use. */
export class DuplicateNodeError extends PriorityGraphError {
  constructor(readonly id: NodeId) {
    super(`Node "${id}" already exists.`);
  }
}

/** Thrown when a dependency would introduce a cycle. */
export class CycleError extends PriorityGraphError {
  /** The offending cycle, e.g. `["a", "b", "a"]` means a depends on b which depends on a. */
  readonly cycle: readonly NodeId[];

  constructor(cycle: readonly NodeId[]) {
    super(`Dependency cycle detected: ${cycle.join(" -> ")}.`);
    this.cycle = cycle;
  }
}

/** Thrown when an operation is not allowed in the node's current state. */
export class InvalidStateError extends PriorityGraphError {
  constructor(
    readonly id: NodeId,
    readonly state: NodeState,
    action: string,
  ) {
    super(`Cannot ${action} node "${id}" while it is ${state}.`);
  }
}

/** Thrown when a snapshot cannot be restored. */
export class InvalidSnapshotError extends PriorityGraphError {}

/**
 * Thrown (and returned by `graph.storeError`) when the injected store failed to
 * apply a batch of changes. The graph refuses further mutations afterwards,
 * because the store no longer matches it; reload the graph from the store.
 */
export class StoreError extends PriorityGraphError {
  constructor(override readonly cause: unknown) {
    super(`The graph store failed to apply changes: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

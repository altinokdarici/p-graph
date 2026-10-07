/** Identifier of a node in the graph. */
export type NodeId = string;

/**
 * Lifecycle of a node:
 *
 * - `pending`: waiting for at least one dependency to complete.
 * - `ready`: all dependencies are completed; the node is in the priority queue.
 * - `in-progress`: handed out by `dequeue()`; waiting for `complete()` or `requeue()`.
 * - `completed`: done; dependents no longer wait on it.
 */
export type NodeState = "pending" | "ready" | "in-progress" | "completed";

/** Read-only view of a node returned by the graph. */
export interface GraphNode<T> {
  readonly id: NodeId;
  readonly data: T;
  /** Priority assigned to the node. Higher values are dequeued first. */
  readonly priority: number;
  /**
   * Priority used for ordering. Equal to `priority` unless `inheritPriority`
   * is enabled, in which case it is the maximum of `priority` and the
   * effective priority of every node that depends on this one.
   */
  readonly effectivePriority: number;
  readonly state: NodeState;
  /** Insertion sequence number; breaks ties between equal priorities (lower first). */
  readonly order: number;
  readonly dependencies: readonly NodeId[];
}

/** A dependency given to `addNode`, optionally carrying edge data. */
export interface DependencySpec<E = undefined> {
  id: NodeId;
  data?: E;
}

export interface AddNodeOptions<E = undefined> {
  /** Defaults to the graph's `defaultPriority` (0 unless configured). */
  priority?: number;
  /**
   * Existing nodes that must complete before this node becomes ready, given as
   * ids or as `{ id, data }` to attach data to the edge.
   */
  dependsOn?: readonly (NodeId | DependencySpec<E>)[];
}

/**
 * Persisted form of a single node: one row in a `nodes` table, one entry in a
 * JSON document. Dependencies are stored separately as {@link DependencyRecord}s.
 * Effective priority is not stored; it is derived when the graph is loaded.
 */
export interface NodeRecord<T> {
  id: NodeId;
  data: T;
  priority: number;
  state: NodeState;
  order: number;
}

/**
 * Persisted form of one edge: node `id` depends on node `dependsOn`. `data` is
 * free-form edge data that the graph stores but never interprets; the key is
 * omitted when there is none.
 */
export interface DependencyRecord<E = undefined> {
  id: NodeId;
  dependsOn: NodeId;
  data?: E;
}

/** Mutable fields of a {@link NodeRecord} reported by `node-updated` changes. */
export type NodeField = "data" | "priority" | "state";

/**
 * One persisted fact that changed. Applying every change, in order, to a copy
 * of a snapshot reproduces the graph's current snapshot exactly.
 */
export type GraphChange<T, E = undefined> =
  | { type: "node-added"; node: NodeRecord<T> }
  | { type: "node-updated"; node: NodeRecord<T>; fields: readonly NodeField[] }
  | { type: "node-removed"; id: NodeId }
  | { type: "dependency-added"; id: NodeId; dependsOn: NodeId; data?: E }
  | { type: "dependency-updated"; id: NodeId; dependsOn: NodeId; data: E }
  | { type: "dependency-removed"; id: NodeId; dependsOn: NodeId };

/**
 * Receives the changes produced by each graph operation, so the graph can be
 * persisted incrementally (SQL rows, a JSON document, a key-value store, ...).
 *
 * `apply` is called once per mutating operation with every change that
 * operation made, which makes each batch a natural transaction boundary.
 * It may be synchronous or return a promise. Batches are always delivered in
 * order and never concurrently; `graph.flush()` resolves once all of them have
 * been applied.
 */
export interface GraphStore<T, E = undefined> {
  apply(changes: readonly GraphChange<T, E>[]): void | PromiseLike<void>;
}

/** Complete, plain-object representation of a graph. */
export interface GraphSnapshot<T, E = undefined> {
  version: 1;
  /** Sorted by `order`. */
  nodes: NodeRecord<T>[];
  dependencies: DependencyRecord<E>[];
}

export interface PriorityGraphOptions<T, E = undefined> {
  /**
   * When true, a node's effective priority is raised to the highest effective
   * priority among the nodes that depend on it, so prerequisites of urgent
   * work are dequeued first. Defaults to `false`.
   */
  inheritPriority?: boolean;
  /** Priority used when `addNode` is called without one. Defaults to `0`. */
  defaultPriority?: number;
  /** Receives every change so the graph can be persisted incrementally. */
  store?: GraphStore<T, E>;
}

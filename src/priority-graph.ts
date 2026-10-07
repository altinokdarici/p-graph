import {
  CycleError,
  DuplicateNodeError,
  InvalidSnapshotError,
  InvalidStateError,
  NodeNotFoundError,
  StoreError,
} from "./errors.js";
import { IndexedHeap, type HeapItem } from "./heap.js";
import type {
  AddNodeOptions,
  DependencyRecord,
  GraphChange,
  GraphNode,
  GraphSnapshot,
  GraphStore,
  NodeField,
  NodeId,
  NodeRecord,
  NodeState,
  PriorityGraphOptions,
} from "./types.js";

interface Entry<T> extends HeapItem {
  readonly id: NodeId;
  data: T;
  priority: number;
  effectivePriority: number;
  state: NodeState;
  readonly order: number;
  readonly dependencies: Set<NodeId>;
  readonly dependents: Set<NodeId>;
  /** Number of dependencies that are not completed yet. */
  unmet: number;
}

const NODE_STATES: readonly NodeState[] = ["pending", "ready", "in-progress", "completed"];

const before = <T>(a: Entry<T>, b: Entry<T>): boolean =>
  a.effectivePriority > b.effectivePriority ||
  (a.effectivePriority === b.effectivePriority && a.order < b.order);

/**
 * A dynamic, dependency-aware priority queue.
 *
 * Nodes become `ready` once all of their dependencies are `completed`, and
 * ready nodes are dequeued highest priority first (ties in insertion order).
 * Nodes, dependencies and priorities can change at any time, including while
 * the graph is being traversed.
 */
export class PriorityGraph<T = unknown> {
  readonly #nodes = new Map<NodeId, Entry<T>>();
  readonly #heap = new IndexedHeap<Entry<T>>(before);
  readonly #counts: Record<NodeState, number> = {
    pending: 0,
    ready: 0,
    "in-progress": 0,
    completed: 0,
  };
  readonly #inheritPriority: boolean;
  readonly #defaultPriority: number;
  readonly #store: GraphStore<T> | undefined;
  #nextOrder = 0;

  #batch: GraphChange<T>[] = [];
  readonly #queue: (readonly GraphChange<T>[])[] = [];
  #pumping = false;
  #inflight: Promise<void> | undefined;
  #storeError: StoreError | undefined;

  constructor(options: PriorityGraphOptions<T> = {}) {
    this.#inheritPriority = options.inheritPriority ?? false;
    this.#defaultPriority = options.defaultPriority ?? 0;
    assertPriority(this.#defaultPriority);
    this.#store = options.store;
  }

  /**
   * Restores a graph from a snapshot (for example one assembled from database
   * rows). `pending`/`ready` states and effective priorities are recomputed
   * from the dependencies. Loading does not emit changes to the store.
   */
  static fromSnapshot<T>(
    snapshot: GraphSnapshot<T>,
    options: PriorityGraphOptions<T> = {},
  ): PriorityGraph<T> {
    const graph = new PriorityGraph<T>(options);
    graph.#load(snapshot);
    return graph;
  }

  /** Total number of nodes, in any state. */
  get size(): number {
    return this.#nodes.size;
  }

  /** True when every node is completed (or the graph is empty). */
  get isComplete(): boolean {
    return this.#counts.completed === this.#nodes.size;
  }

  /** The error that made the store diverge from the graph, if any. */
  get storeError(): StoreError | undefined {
    return this.#storeError;
  }

  /** Number of nodes in `state`, or of all nodes when omitted. */
  count(state?: NodeState): number {
    return state === undefined ? this.#nodes.size : this.#counts[state];
  }

  has(id: NodeId): boolean {
    return this.#nodes.has(id);
  }

  get(id: NodeId): GraphNode<T> | undefined {
    const entry = this.#nodes.get(id);
    return entry && this.#view(entry);
  }

  /** Nodes in insertion order, optionally filtered by state. */
  *nodes(state?: NodeState): IterableIterator<GraphNode<T>> {
    for (const entry of this.#nodes.values()) {
      if (state === undefined || entry.state === state) {
        yield this.#view(entry);
      }
    }
  }

  dependenciesOf(id: NodeId): NodeId[] {
    return [...this.#require(id).dependencies];
  }

  dependentsOf(id: NodeId): NodeId[] {
    return [...this.#require(id).dependents];
  }

  /**
   * Adds a node. It is `ready` immediately unless one of `dependsOn` is not
   * completed yet. Dependencies must already exist.
   */
  addNode(id: NodeId, data: T, options: AddNodeOptions = {}): GraphNode<T> {
    this.#assertWritable();
    if (typeof id !== "string") {
      throw new TypeError(`Node id must be a string, got ${typeof id}.`);
    }
    if (this.#nodes.has(id)) {
      throw new DuplicateNodeError(id);
    }
    const priority = options.priority ?? this.#defaultPriority;
    assertPriority(priority);
    if (typeof options.dependsOn === "string") {
      throw new TypeError("dependsOn must be an array of node ids, not a string.");
    }
    const dependencies = new Set<NodeId>(options.dependsOn ?? []);
    for (const dependency of dependencies) {
      this.#require(dependency);
    }

    return this.#mutate(() => {
      const entry = this.#createEntry(id, data, priority, this.#nextOrder++, dependencies);
      for (const dependency of dependencies) {
        const target = this.#nodes.get(dependency) as Entry<T>;
        target.dependents.add(id);
        if (target.state !== "completed") {
          entry.unmet++;
        }
      }
      entry.state = entry.unmet === 0 ? "ready" : "pending";
      this.#counts[entry.state]++;
      if (entry.state === "ready") {
        this.#heap.push(entry);
      }
      this.#record({ type: "node-added", node: toRecord(entry) });
      for (const dependency of dependencies) {
        this.#record({ type: "dependency-added", id, dependsOn: dependency });
      }
      this.#refresh(this.#entries(dependencies));
      return this.#view(entry);
    });
  }

  /**
   * Removes a node and all of its edges. Nodes that only waited on it become
   * ready. Returns false when the node does not exist.
   */
  removeNode(id: NodeId): boolean {
    this.#assertWritable();
    const entry = this.#nodes.get(id);
    if (!entry) {
      return false;
    }
    this.#mutate(() => this.#remove(entry));
    return true;
  }

  /** Removes every completed node; useful to bound memory in long-lived graphs. */
  pruneCompleted(): number {
    this.#assertWritable();
    const completed = [...this.#nodes.values()].filter((entry) => entry.state === "completed");
    this.#mutate(() => {
      for (const entry of completed) {
        this.#remove(entry);
      }
    });
    return completed.length;
  }

  setPriority(id: NodeId, priority: number): void {
    this.#assertWritable();
    const entry = this.#require(id);
    assertPriority(priority);
    if (entry.priority === priority) {
      return;
    }
    this.#mutate(() => {
      entry.priority = priority;
      this.#recordUpdate(entry, "priority");
      this.#refresh([entry]);
    });
  }

  setData(id: NodeId, data: T): void {
    this.#assertWritable();
    const entry = this.#require(id);
    this.#mutate(() => {
      entry.data = data;
      this.#recordUpdate(entry, "data");
    });
  }

  /**
   * Makes `id` wait for `dependsOn`. Only nodes that have not started
   * (`pending` or `ready`) can gain dependencies. Adding an existing edge is a
   * no-op. Throws {@link CycleError} if the edge would create a cycle.
   */
  addDependency(id: NodeId, dependsOn: NodeId): void {
    this.#assertWritable();
    const entry = this.#require(id);
    const target = this.#require(dependsOn);
    if (entry.dependencies.has(dependsOn)) {
      return;
    }
    if (entry.state !== "pending" && entry.state !== "ready") {
      throw new InvalidStateError(id, entry.state, "add a dependency to");
    }
    const cycle = this.#findPath(target, entry);
    if (cycle) {
      throw new CycleError([id, ...cycle]);
    }

    this.#mutate(() => {
      entry.dependencies.add(dependsOn);
      target.dependents.add(id);
      this.#record({ type: "dependency-added", id, dependsOn });
      if (target.state !== "completed") {
        entry.unmet++;
        if (entry.state === "ready") {
          this.#heap.remove(entry);
          this.#setState(entry, "pending");
        }
      }
      this.#refresh([target]);
    });
  }

  /** Returns false when the edge does not exist. */
  removeDependency(id: NodeId, dependsOn: NodeId): boolean {
    this.#assertWritable();
    const entry = this.#require(id);
    const target = this.#require(dependsOn);
    if (!entry.dependencies.has(dependsOn)) {
      return false;
    }
    this.#mutate(() => {
      entry.dependencies.delete(dependsOn);
      target.dependents.delete(id);
      this.#record({ type: "dependency-removed", id, dependsOn });
      if (target.state !== "completed") {
        this.#satisfy(entry);
      }
      this.#refresh([target]);
    });
    return true;
  }

  /** The node `dequeue()` would return, without changing anything. */
  peek(): GraphNode<T> | undefined {
    const entry = this.#heap.peek();
    return entry && this.#view(entry);
  }

  /**
   * Takes the highest-priority ready node and marks it `in-progress`. Call
   * `complete()` (or `requeue()`) when done with it. Returns undefined when no
   * node is ready.
   */
  dequeue(): GraphNode<T> | undefined {
    this.#assertWritable();
    const entry = this.#heap.peek();
    if (!entry) {
      return undefined;
    }
    return this.#mutate(() => {
      this.#heap.remove(entry);
      this.#setState(entry, "in-progress");
      return this.#view(entry);
    });
  }

  /**
   * Marks an `in-progress` node as completed. Returns the ids of the nodes that
   * became ready as a result.
   */
  complete(id: NodeId): NodeId[] {
    this.#assertWritable();
    const entry = this.#require(id);
    if (entry.state !== "in-progress") {
      throw new InvalidStateError(id, entry.state, "complete");
    }
    return this.#mutate(() => {
      this.#setState(entry, "completed");
      const unblocked: NodeId[] = [];
      for (const dependent of this.#entries(entry.dependents)) {
        if (this.#satisfy(dependent)) {
          unblocked.push(dependent.id);
        }
      }
      return unblocked;
    });
  }

  /** Puts an `in-progress` node back into the queue, e.g. to retry it. */
  requeue(id: NodeId): void {
    this.#assertWritable();
    const entry = this.#require(id);
    if (entry.state !== "in-progress") {
      throw new InvalidStateError(id, entry.state, "requeue");
    }
    this.#mutate(() => {
      this.#setState(entry, "ready");
      this.#heap.push(entry);
    });
  }

  /**
   * Yields ready nodes in priority order until none are left, completing each
   * node when the consumer asks for the next one (unless the consumer already
   * completed, requeued or removed it). Nodes added or unblocked during
   * traversal are picked up immediately. If the loop exits early, the last
   * yielded node stays `in-progress`.
   */
  *traverse(): Generator<GraphNode<T>, void, undefined> {
    for (let node = this.dequeue(); node; node = this.dequeue()) {
      yield node;
      if (this.#nodes.get(node.id)?.state === "in-progress") {
        this.complete(node.id);
      }
    }
  }

  /** Full plain-object copy of the graph. Node data is not cloned. */
  toSnapshot(): GraphSnapshot<T> {
    const nodes: NodeRecord<T>[] = [];
    const dependencies: DependencyRecord[] = [];
    for (const entry of this.#nodes.values()) {
      nodes.push(toRecord(entry));
      for (const dependsOn of entry.dependencies) {
        dependencies.push({ id: entry.id, dependsOn });
      }
    }
    return { version: 1, nodes, dependencies };
  }

  /**
   * Resolves once every change has been applied by the store. Rejects with a
   * {@link StoreError} if the store failed.
   */
  async flush(): Promise<void> {
    while (this.#inflight) {
      await this.#inflight;
    }
    if (this.#storeError) {
      throw this.#storeError;
    }
  }

  // --- internals -----------------------------------------------------------

  #createEntry(
    id: NodeId,
    data: T,
    priority: number,
    order: number,
    dependencies: Set<NodeId>,
  ): Entry<T> {
    const entry: Entry<T> = {
      id,
      data,
      priority,
      effectivePriority: priority,
      state: "pending",
      order,
      dependencies,
      dependents: new Set(),
      unmet: 0,
      heapIndex: -1,
    };
    this.#nodes.set(id, entry);
    return entry;
  }

  #remove(entry: Entry<T>): void {
    for (const dependency of this.#entries(entry.dependencies)) {
      dependency.dependents.delete(entry.id);
      this.#record({ type: "dependency-removed", id: entry.id, dependsOn: dependency.id });
    }
    for (const dependent of this.#entries(entry.dependents)) {
      dependent.dependencies.delete(entry.id);
      this.#record({ type: "dependency-removed", id: dependent.id, dependsOn: entry.id });
    }
    this.#heap.remove(entry);
    this.#nodes.delete(entry.id);
    this.#counts[entry.state]--;
    this.#record({ type: "node-removed", id: entry.id });

    if (entry.state !== "completed") {
      for (const dependent of this.#entries(entry.dependents)) {
        this.#satisfy(dependent);
      }
    }
    this.#refresh(this.#entries(entry.dependencies));
  }

  /** One unmet dependency of `entry` went away. Returns true if it became ready. */
  #satisfy(entry: Entry<T>): boolean {
    entry.unmet--;
    if (entry.unmet === 0 && entry.state === "pending") {
      this.#setState(entry, "ready");
      this.#heap.push(entry);
      return true;
    }
    return false;
  }

  #setState(entry: Entry<T>, state: NodeState): void {
    this.#counts[entry.state]--;
    this.#counts[state]++;
    entry.state = state;
    this.#recordUpdate(entry, "state");
  }

  /** Recomputes effective priorities starting at `start`, following dependencies. */
  #refresh(start: Iterable<Entry<T>>): void {
    const work = new Set(start);
    for (const entry of work) {
      work.delete(entry);
      let effective = entry.priority;
      if (this.#inheritPriority) {
        for (const dependent of this.#entries(entry.dependents)) {
          if (dependent.effectivePriority > effective) {
            effective = dependent.effectivePriority;
          }
        }
      }
      if (effective !== entry.effectivePriority) {
        entry.effectivePriority = effective;
        this.#heap.update(entry);
        if (this.#inheritPriority) {
          for (const dependency of this.#entries(entry.dependencies)) {
            work.add(dependency);
          }
        }
      }
    }
  }

  /** Path of ids from `from` to `to` along dependency edges, if one exists. */
  #findPath(from: Entry<T>, to: Entry<T>): NodeId[] | undefined {
    const parents = new Map<Entry<T>, Entry<T> | undefined>([[from, undefined]]);
    const stack = [from];
    while (stack.length > 0) {
      const current = stack.pop() as Entry<T>;
      if (current === to) {
        const path: NodeId[] = [];
        for (let step: Entry<T> | undefined = current; step; step = parents.get(step)) {
          path.push(step.id);
        }
        return path.reverse();
      }
      // A completed node only depends on completed nodes, and `to` is never completed here.
      if (current.state === "completed") {
        continue;
      }
      for (const next of this.#entries(current.dependencies)) {
        if (!parents.has(next)) {
          parents.set(next, current);
          stack.push(next);
        }
      }
    }
    return undefined;
  }

  #load(snapshot: GraphSnapshot<T>): void {
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.nodes)) {
      throw new InvalidSnapshotError("Unsupported snapshot format; expected version 1.");
    }
    const records = [...snapshot.nodes].sort((a, b) => a.order - b.order);
    let previousOrder = -Infinity;
    for (const record of records) {
      if (typeof record.id !== "string") {
        throw new InvalidSnapshotError("Every node must have a string id.");
      }
      if (this.#nodes.has(record.id)) {
        throw new InvalidSnapshotError(`Duplicate node "${record.id}".`);
      }
      if (!Number.isInteger(record.order) || record.order === previousOrder) {
        throw new InvalidSnapshotError(`Node "${record.id}" has a missing or duplicate order.`);
      }
      if (!NODE_STATES.includes(record.state)) {
        throw new InvalidSnapshotError(`Node "${record.id}" has invalid state "${record.state}".`);
      }
      assertPriority(record.priority);
      previousOrder = record.order;
      const entry = this.#createEntry(record.id, record.data, record.priority, record.order, new Set());
      entry.state = record.state;
      this.#nextOrder = record.order + 1;
    }

    for (const { id, dependsOn } of snapshot.dependencies ?? []) {
      const entry = this.#nodes.get(id);
      const target = this.#nodes.get(dependsOn);
      if (!entry || !target) {
        throw new InvalidSnapshotError(`Dependency "${id}" -> "${dependsOn}" references a missing node.`);
      }
      entry.dependencies.add(dependsOn);
      target.dependents.add(id);
    }

    // Kahn's algorithm: dependencies before dependents.
    const order: Entry<T>[] = [];
    const remaining = new Map<Entry<T>, number>();
    for (const entry of this.#nodes.values()) {
      remaining.set(entry, entry.dependencies.size);
      if (entry.dependencies.size === 0) {
        order.push(entry);
      }
    }
    for (let i = 0; i < order.length; i++) {
      for (const dependent of this.#entries((order[i] as Entry<T>).dependents)) {
        const left = (remaining.get(dependent) as number) - 1;
        remaining.set(dependent, left);
        if (left === 0) {
          order.push(dependent);
        }
      }
    }
    if (order.length !== this.#nodes.size) {
      // Every unprocessed node has an unprocessed dependency, so walking them must loop.
      const isStuck = (entry: Entry<T>): boolean => (remaining.get(entry) as number) > 0;
      const path: Entry<T>[] = [];
      let current = [...remaining.keys()].find(isStuck) as Entry<T>;
      while (!path.includes(current)) {
        path.push(current);
        current = [...this.#entries(current.dependencies)].find(isStuck) as Entry<T>;
      }
      const cycle = path.slice(path.indexOf(current)).map((entry) => entry.id);
      throw new CycleError([...cycle, current.id]);
    }

    for (const entry of order) {
      for (const dependency of this.#entries(entry.dependencies)) {
        if (dependency.state !== "completed") {
          entry.unmet++;
        }
      }
      if (entry.state === "pending" || entry.state === "ready") {
        entry.state = entry.unmet === 0 ? "ready" : "pending";
      } else if (entry.unmet > 0) {
        throw new InvalidSnapshotError(
          `Node "${entry.id}" is ${entry.state} but has dependencies that are not completed.`,
        );
      }
      this.#counts[entry.state]++;
    }

    for (let i = order.length - 1; i >= 0; i--) {
      const entry = order[i] as Entry<T>;
      if (this.#inheritPriority) {
        for (const dependent of this.#entries(entry.dependents)) {
          entry.effectivePriority = Math.max(entry.effectivePriority, dependent.effectivePriority);
        }
      }
      if (entry.state === "ready") {
        this.#heap.push(entry);
      }
    }
  }

  #require(id: NodeId): Entry<T> {
    const entry = this.#nodes.get(id);
    if (!entry) {
      throw new NodeNotFoundError(id);
    }
    return entry;
  }

  *#entries(ids: Iterable<NodeId>): Generator<Entry<T>> {
    for (const id of ids) {
      yield this.#nodes.get(id) as Entry<T>;
    }
  }

  #view(entry: Entry<T>): GraphNode<T> {
    return {
      id: entry.id,
      data: entry.data,
      priority: entry.priority,
      effectivePriority: entry.effectivePriority,
      state: entry.state,
      order: entry.order,
      dependencies: [...entry.dependencies],
    };
  }

  // --- change tracking -----------------------------------------------------

  #assertWritable(): void {
    if (this.#storeError) {
      throw this.#storeError;
    }
  }

  #mutate<R>(operation: () => R): R {
    try {
      return operation();
    } finally {
      this.#emit();
    }
  }

  #record(change: GraphChange<T>): void {
    if (this.#store) {
      this.#batch.push(change);
    }
  }

  #recordUpdate(entry: Entry<T>, field: NodeField): void {
    if (this.#store) {
      this.#batch.push({ type: "node-updated", node: toRecord(entry), fields: [field] });
    }
  }

  #emit(): void {
    const batch = this.#batch;
    if (batch.length === 0) {
      return;
    }
    this.#batch = [];
    this.#queue.push(batch);
    // While a batch is being applied (even synchronously, e.g. when the store
    // calls back into the graph), new batches wait their turn in the queue.
    if (!this.#pumping) {
      this.#pump();
    }
  }

  #pump(): void {
    const store = this.#store as GraphStore<T>;
    this.#pumping = true;
    while (this.#queue.length > 0 && !this.#storeError) {
      const batch = this.#queue.shift() as readonly GraphChange<T>[];
      let result: void | PromiseLike<void>;
      try {
        result = store.apply(batch);
      } catch (cause) {
        this.#pumping = false;
        throw this.#fail(cause);
      }
      if (isPromiseLike(result)) {
        // Stay in pumping mode until the store settles, then continue.
        this.#inflight = Promise.resolve(result).then(
          () => {
            this.#inflight = undefined;
            try {
              this.#pump();
            } catch {
              // Already recorded in #storeError and reported by flush().
            }
          },
          (cause: unknown) => {
            this.#inflight = undefined;
            this.#pumping = false;
            this.#fail(cause);
          },
        );
        return;
      }
    }
    this.#pumping = false;
  }

  #fail(cause: unknown): StoreError {
    this.#queue.length = 0;
    this.#storeError = new StoreError(cause);
    return this.#storeError;
  }
}

function toRecord<T>(entry: Entry<T>): NodeRecord<T> {
  return {
    id: entry.id,
    data: entry.data,
    priority: entry.priority,
    state: entry.state,
    order: entry.order,
  };
}

function assertPriority(priority: unknown): asserts priority is number {
  if (typeof priority !== "number" || Number.isNaN(priority)) {
    throw new TypeError(`Priority must be a number, got ${String(priority)}.`);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as PromiseLike<void>).then === "function"
  );
}

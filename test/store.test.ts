import { describe, expect, it } from "vitest";
import {
  applyChanges,
  PriorityGraph,
  StoreError,
  type GraphChange,
  type GraphSnapshot,
  type GraphStore,
} from "../src/index.js";

const emptySnapshot = <T>(): GraphSnapshot<T> => ({ version: 1, nodes: [], dependencies: [] });

/** Order-insensitive form of a snapshot, for comparisons. */
function normalize<T, E>(snapshot: GraphSnapshot<T, E>) {
  return {
    version: snapshot.version,
    nodes: [...snapshot.nodes].sort((a, b) => a.order - b.order),
    dependencies: snapshot.dependencies
      .map((edge) => `${edge.id}->${edge.dependsOn}${"data" in edge ? `:${JSON.stringify(edge.data)}` : ""}`)
      .sort(),
  };
}

class RecordingStore<T, E = undefined> implements GraphStore<T, E> {
  readonly batches: GraphChange<T, E>[][] = [];
  readonly document: GraphSnapshot<T, E> = { version: 1, nodes: [], dependencies: [] };

  apply(changes: readonly GraphChange<T, E>[]): void {
    this.batches.push([...changes]);
    applyChanges(this.document, changes);
  }
}

describe("incremental store", () => {
  it("emits one batch per operation", () => {
    const store = new RecordingStore<string>();
    const graph = new PriorityGraph<string>({ store });
    graph.addNode("a", "A", { priority: 2 });
    graph.addNode("b", "B", { dependsOn: ["a"] });
    graph.dequeue();
    graph.complete("a");

    expect(store.batches).toEqual([
      [{ type: "node-added", node: { id: "a", data: "A", priority: 2, state: "ready", order: 0 } }],
      [
        { type: "node-added", node: { id: "b", data: "B", priority: 0, state: "pending", order: 1 } },
        { type: "dependency-added", id: "b", dependsOn: "a" },
      ],
      [
        {
          type: "node-updated",
          node: { id: "a", data: "A", priority: 2, state: "in-progress", order: 0 },
          fields: ["state"],
        },
      ],
      [
        {
          type: "node-updated",
          node: { id: "a", data: "A", priority: 2, state: "completed", order: 0 },
          fields: ["state"],
        },
        {
          type: "node-updated",
          node: { id: "b", data: "B", priority: 0, state: "ready", order: 1 },
          fields: ["state"],
        },
      ],
    ]);
  });

  it("emits nothing for no-ops, reads and failed validation", () => {
    const store = new RecordingStore<null>();
    const graph = new PriorityGraph<null>({ store });
    graph.addNode("a", null);
    store.batches.length = 0;
    graph.setPriority("a", 0);
    graph.addNode("b", null, { dependsOn: ["a"] });
    store.batches.length = 0;
    graph.addDependency("b", "a");
    graph.removeDependency("a", "b");
    graph.peek();
    graph.toSnapshot();
    expect(() => graph.addDependency("a", "b")).toThrow();
    expect(store.batches).toEqual([]);
  });

  it("removes edges before the node so foreign keys stay valid", () => {
    const store = new RecordingStore<null>();
    const graph = new PriorityGraph<null>({ store });
    graph.addNode("a", null);
    graph.addNode("b", null, { dependsOn: ["a"] });
    graph.addNode("c", null, { dependsOn: ["b"] });
    store.batches.length = 0;
    graph.removeNode("b");
    expect(store.batches[0]?.map((change) => change.type)).toEqual([
      "dependency-removed",
      "dependency-removed",
      "node-removed",
      "node-updated",
    ]);
  });

  it("delivers async batches in order and flush() waits for them", async () => {
    const applied: string[] = [];
    const store: GraphStore<null> = {
      async apply(changes) {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
        applied.push(changes.map((change) => change.type).join(","));
      },
    };
    const graph = new PriorityGraph<null>({ store });
    graph.addNode("a", null);
    graph.addNode("b", null, { dependsOn: ["a"] });
    graph.dequeue();
    graph.complete("a");
    expect(applied).toEqual([]);
    await graph.flush();
    expect(applied).toEqual([
      "node-added",
      "node-added,dependency-added",
      "node-updated",
      "node-updated,node-updated",
    ]);
  });

  it("queues batches produced by a synchronous store that calls back into the graph", () => {
    const document = emptySnapshot<null>();
    const log: string[] = [];
    let depth = 0;
    const graph: PriorityGraph<null> = new PriorityGraph<null>({
      store: {
        apply(changes) {
          depth++;
          log.push(`${depth}:${changes.map((change) => change.type).join(",")}`);
          if (changes.some((change) => change.type === "node-added")) {
            graph.dequeue();
          }
          applyChanges(document, changes);
          depth--;
        },
      },
    });
    graph.addNode("a", null);
    expect(log).toEqual(["1:node-added", "1:node-updated"]);
    expect(normalize(document)).toEqual(normalize(graph.toSnapshot()));
  });

  it("never runs async batches concurrently, even when the store calls back into the graph", async () => {
    const document = emptySnapshot<null>();
    let active = 0;
    let maxActive = 0;
    const graph: PriorityGraph<null> = new PriorityGraph<null>({
      store: {
        async apply(changes) {
          active++;
          maxActive = Math.max(maxActive, active);
          if (changes.some((change) => change.type === "node-added")) {
            graph.dequeue();
          }
          await new Promise((resolve) => setTimeout(resolve, 2));
          applyChanges(document, changes);
          active--;
        },
      },
    });
    graph.addNode("a", null);
    graph.addNode("b", null);
    await graph.flush();
    expect(maxActive).toBe(1);
    expect(normalize(document)).toEqual(normalize(graph.toSnapshot()));
    expect(graph.count("in-progress")).toBe(2);
  });

  it("latches a synchronous store failure", () => {
    let fail = false;
    const graph = new PriorityGraph<null>({
      store: {
        apply() {
          if (fail) {
            throw new Error("disk full");
          }
        },
      },
    });
    graph.addNode("a", null);
    fail = true;
    expect(() => graph.addNode("b", null)).toThrow(StoreError);
    expect(graph.storeError?.cause).toEqual(new Error("disk full"));
    expect(() => graph.dequeue()).toThrow(StoreError);
    expect(graph.size).toBe(2);
    expect(graph.peek()?.id).toBe("a");
  });

  it("latches an asynchronous store failure and reports it from flush()", async () => {
    const graph = new PriorityGraph<null>({
      store: { apply: () => Promise.reject(new Error("connection lost")) },
    });
    graph.addNode("a", null);
    graph.addNode("b", null);
    await expect(graph.flush()).rejects.toBeInstanceOf(StoreError);
    expect(() => graph.addNode("c", null)).toThrow(StoreError);
  });

  it("reproduces the graph exactly from the change stream (randomized)", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = mulberry32(seed);
      const pick = <T>(items: readonly T[]): T | undefined =>
        items[Math.floor(random() * items.length)];
      const inheritPriority = seed % 2 === 0;
      const store = new RecordingStore<number, string>();
      const graph = new PriorityGraph<number, string>({ store, inheritPriority });
      let next = 0;

      for (let step = 0; step < 300; step++) {
        const all = [...graph.nodes()];
        const allIds = all.map((node) => node.id);
        const roll = random();
        try {
          if (roll < 0.3 || all.length === 0) {
            const dependsOn = allIds
              .filter(() => random() < 0.15)
              .map((id) => (random() < 0.5 ? id : { id, data: `s${step}` }));
            graph.addNode(`n${next++}`, step, { priority: Math.floor(random() * 10), dependsOn });
          } else if (roll < 0.5) {
            const node = graph.dequeue();
            if (node && random() < 0.8) {
              graph.complete(node.id);
            }
          } else if (roll < 0.6) {
            const inProgress = all.filter((node) => node.state === "in-progress");
            const node = pick(inProgress);
            if (node) {
              if (random() < 0.5) {
                graph.complete(node.id);
              } else {
                graph.requeue(node.id);
              }
            }
          } else if (roll < 0.72) {
            graph.addDependency(pick(allIds)!, pick(allIds)!, random() < 0.5 ? `a${step}` : undefined);
          } else if (roll < 0.8) {
            const node = pick(all.filter((n) => n.dependencies.length > 0));
            if (node) {
              graph.removeDependency(node.id, pick(node.dependencies)!);
            }
          } else if (roll < 0.88) {
            graph.setPriority(pick(allIds)!, Math.floor(random() * 10));
          } else if (roll < 0.92) {
            graph.removeNode(pick(allIds)!);
          } else if (roll < 0.93) {
            graph.pruneCompleted();
          } else if (roll < 0.95) {
            graph.setData(pick(allIds)!, -step);
          } else {
            const node = pick(all.filter((n) => n.dependencies.length > 0));
            if (node) {
              graph.setDependencyData(node.id, pick(node.dependencies)!, `u${step}`);
            }
          }
        } catch (error) {
          if (!(error instanceof Error) || !/cycle|Cannot/i.test(error.message)) {
            throw error;
          }
        }

        expect(normalize(store.document)).toEqual(normalize(graph.toSnapshot()));
        checkInvariants(graph, inheritPriority);
      }

      const restored = PriorityGraph.fromSnapshot(structuredClone(store.document), { inheritPriority });
      expect(normalize(restored.toSnapshot())).toEqual(normalize(graph.toSnapshot()));
      expect([...restored.nodes()].map(sortDeps)).toEqual([...graph.nodes()].map(sortDeps));
      const order = (g: PriorityGraph<number, string>) => [...g.traverse()].map((node) => node.id);
      expect(order(restored)).toEqual(order(graph));
    }
  });
});

function sortDeps<T extends { dependencies: readonly string[] }>(node: T): T {
  return { ...node, dependencies: [...node.dependencies].sort() };
}

function checkInvariants(graph: PriorityGraph<number, string>, inheritPriority: boolean): void {
  const nodes = new Map([...graph.nodes()].map((node) => [node.id, node]));
  const effective = new Map<string, number>();
  const effectiveOf = (id: string): number => {
    const cached = effective.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const node = nodes.get(id)!;
    let value = node.priority;
    if (inheritPriority) {
      for (const dependent of graph.dependentsOf(id)) {
        value = Math.max(value, effectiveOf(dependent));
      }
    }
    effective.set(id, value);
    return value;
  };

  for (const node of nodes.values()) {
    const unmet = node.dependencies.filter((dep) => nodes.get(dep)!.state !== "completed");
    if (node.state === "pending") {
      expect(unmet.length).toBeGreaterThan(0);
    } else {
      expect(unmet).toEqual([]);
    }
    expect(node.effectivePriority).toBe(effectiveOf(node.id));
  }

  const ready = [...nodes.values()].filter((node) => node.state === "ready");
  ready.sort((a, b) => b.effectivePriority - a.effectivePriority || a.order - b.order);
  expect(graph.peek()?.id).toBe(ready[0]?.id);
  expect(graph.count("ready")).toBe(ready.length);
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

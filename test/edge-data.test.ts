import { describe, expect, it } from "vitest";
import {
  applyChanges,
  DependencyNotFoundError,
  NodeNotFoundError,
  PriorityGraph,
  type GraphChange,
  type GraphSnapshot,
  type GraphStore,
} from "../src/index.js";

interface Edge {
  label: string;
  when?: "pass" | "fail";
  addedBy?: string;
}

class RecordingStore<T, E> implements GraphStore<T, E> {
  readonly batches: GraphChange<T, E>[][] = [];
  readonly document: GraphSnapshot<T, E> = { version: 1, nodes: [], dependencies: [] };

  apply(changes: readonly GraphChange<T, E>[]): void {
    this.batches.push([...changes]);
    applyChanges(this.document, changes);
  }
}

const sorted = <T, E>(snapshot: GraphSnapshot<T, E>): GraphSnapshot<T, E> => ({
  version: snapshot.version,
  nodes: [...snapshot.nodes].sort((a, b) => a.order - b.order),
  dependencies: [...snapshot.dependencies].sort((a, b) =>
    `${a.id}->${a.dependsOn}`.localeCompare(`${b.id}->${b.dependsOn}`),
  ),
});

describe("edge data", () => {
  it("stores data given to addNode and addDependency", () => {
    const graph = new PriorityGraph<null, Edge>();
    graph.addNode("a", null);
    graph.addNode("b", null);
    graph.addNode("c", null, { dependsOn: ["a", { id: "b", data: { label: "after b" } }] });
    graph.addDependency("c", "a", { label: "ignored" }); // existing edge: no-op
    graph.addNode("d", null);
    graph.addDependency("c", "d", { label: "if evals fail", when: "fail", addedBy: "fix-A" });

    expect(graph.dependencyEdges("c")).toEqual([
      { id: "c", dependsOn: "a" },
      { id: "c", dependsOn: "b", data: { label: "after b" } },
      { id: "c", dependsOn: "d", data: { label: "if evals fail", when: "fail", addedBy: "fix-A" } },
    ]);
    expect(graph.dependencyEdges("c")[0]).not.toHaveProperty("data");
    expect(graph.dependentEdges("b")).toEqual([{ id: "c", dependsOn: "b", data: { label: "after b" } }]);
    expect(graph.dependentEdges("c")).toEqual([]);
    expect(graph.dependenciesOf("c")).toEqual(["a", "b", "d"]);
    expect(graph.get("c")?.dependencies).toEqual(["a", "b", "d"]);
  });

  it("keeps existing data when an edge is added again", () => {
    const graph = new PriorityGraph<null, string>();
    graph.addNode("a", null);
    graph.addNode("b", null, { dependsOn: [{ id: "a", data: "first" }, { id: "a", data: "second" }] });
    graph.addDependency("b", "a", "third");
    expect(graph.dependencyEdges("b")).toEqual([{ id: "b", dependsOn: "a", data: "first" }]);
  });

  it("validates dependency specs", () => {
    const graph = new PriorityGraph<null, string>();
    expect(() => graph.addNode("a", null, { dependsOn: [{ id: "missing" }] })).toThrow(NodeNotFoundError);
    expect(() =>
      graph.addNode("a", null, { dependsOn: [{ nope: true } as unknown as { id: string }] }),
    ).toThrow(TypeError);
    expect(graph.size).toBe(0);
  });

  it("updates edge data with setDependencyData and emits dependency-updated", () => {
    const store = new RecordingStore<null, Edge>();
    const graph = new PriorityGraph<null, Edge>({ store });
    graph.addNode("a", null);
    graph.addNode("b", null, { dependsOn: [{ id: "a", data: { label: "one" } }] });
    graph.dequeue();
    graph.complete("a");
    graph.dequeue();
    graph.complete("b");

    graph.setDependencyData("b", "a", { label: "two", when: "pass" });
    expect(store.batches.at(-1)).toEqual([
      { type: "dependency-updated", id: "b", dependsOn: "a", data: { label: "two", when: "pass" } },
    ]);
    expect(graph.dependencyEdges("b")).toEqual([
      { id: "b", dependsOn: "a", data: { label: "two", when: "pass" } },
    ]);
    expect(sorted(store.document)).toEqual(sorted(graph.toSnapshot()));

    const batches = store.batches.length;
    expect(() => graph.setDependencyData("a", "b", { label: "x" })).toThrow(DependencyNotFoundError);
    expect(() => graph.setDependencyData("b", "zzz", { label: "x" })).toThrow(NodeNotFoundError);
    expect(store.batches.length).toBe(batches);
  });

  it("emits edge data on dependency-added and omits it when undefined", () => {
    const store = new RecordingStore<null, string>();
    const graph = new PriorityGraph<null, string>({ store });
    graph.addNode("a", null);
    graph.addNode("b", null, { dependsOn: [{ id: "a", data: "x" }] });
    graph.addNode("c", null, { dependsOn: ["a"] });
    graph.addNode("d", null);
    graph.addDependency("d", "a", "y");

    const added = store.batches.flat().filter((change) => change.type === "dependency-added");
    expect(added).toEqual([
      { type: "dependency-added", id: "b", dependsOn: "a", data: "x" },
      { type: "dependency-added", id: "c", dependsOn: "a" },
      { type: "dependency-added", id: "d", dependsOn: "a", data: "y" },
    ]);
    expect(added[1]).not.toHaveProperty("data");
  });

  it("round-trips edge data through snapshots", () => {
    const graph = new PriorityGraph<string, Edge>();
    graph.addNode("a", "A");
    graph.addNode("b", "B", { dependsOn: [{ id: "a", data: { label: "after a" } }] });
    graph.addNode("c", "C", { dependsOn: ["a", "b"] });

    const snapshot = graph.toSnapshot();
    expect(snapshot.dependencies).toEqual([
      { id: "b", dependsOn: "a", data: { label: "after a" } },
      { id: "c", dependsOn: "a" },
      { id: "c", dependsOn: "b" },
    ]);
    expect(snapshot.version).toBe(1);

    const restored = PriorityGraph.fromSnapshot(structuredClone(snapshot));
    expect(restored.toSnapshot()).toEqual(snapshot);
    expect(restored.dependentEdges("a")).toEqual([
      { id: "b", dependsOn: "a", data: { label: "after a" } },
      { id: "c", dependsOn: "a" },
    ]);
  });
});

describe("change stream", () => {
  it("reproduces the snapshot with edge data, including dependency-updated", () => {
    const store = new RecordingStore<string, Edge>();
    const graph = new PriorityGraph<string, Edge>({ store });
    graph.addNode("build", "B");
    graph.addNode("evals", "E", { dependsOn: [{ id: "build", data: { label: "after build" } }] });
    graph.addNode("ship", "S", { dependsOn: [{ id: "evals", data: { label: "if evals pass", when: "pass" } }] });
    graph.addNode("fix", "F");
    graph.addDependency("evals", "fix", { label: "after fixing", when: "fail", addedBy: "fix-A" });
    graph.addDependency("ship", "fix");
    graph.setDependencyData("ship", "fix", { label: "after fix" });
    graph.setDependencyData("evals", "build", { label: "after build", addedBy: "user" });
    graph.removeDependency("ship", "fix");
    for (const _ of graph.traverse()) {
      // run everything
    }
    graph.removeNode("fix");

    const types = store.batches.flat().map((change) => change.type);
    expect(types.filter((type) => type === "dependency-updated")).toHaveLength(2);
    expect(sorted(store.document)).toEqual(sorted(graph.toSnapshot()));
    const replayed = applyChanges<string, Edge>(
      { version: 1, nodes: [], dependencies: [] },
      store.batches.flat(),
    );
    expect(sorted(replayed)).toEqual(sorted(graph.toSnapshot()));
    expect(PriorityGraph.fromSnapshot(structuredClone(replayed)).toSnapshot()).toEqual(graph.toSnapshot());
  });
});

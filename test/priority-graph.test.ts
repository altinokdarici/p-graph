import { describe, expect, it } from "vitest";
import {
  CycleError,
  DuplicateNodeError,
  InvalidSnapshotError,
  InvalidStateError,
  NodeNotFoundError,
  PriorityGraph,
  type GraphNode,
  type NodeState,
} from "../src/index.js";

const ids = (nodes: Iterable<GraphNode<unknown>>): string[] => [...nodes].map((node) => node.id);

function drain<T>(graph: PriorityGraph<T>): string[] {
  return ids(graph.traverse());
}

describe("PriorityGraph basics", () => {
  it("dequeues by priority, breaking ties in insertion order", () => {
    const graph = new PriorityGraph<string>();
    graph.addNode("low", "l", { priority: 1 });
    graph.addNode("high", "h", { priority: 10 });
    graph.addNode("mid-a", "a", { priority: 5 });
    graph.addNode("mid-b", "b", { priority: 5 });
    expect(drain(graph)).toEqual(["high", "mid-a", "mid-b", "low"]);
    expect(graph.isComplete).toBe(true);
  });

  it("uses defaultPriority when none is given", () => {
    const graph = new PriorityGraph({ defaultPriority: 3 });
    expect(graph.addNode("a", null).priority).toBe(3);
  });

  it("keeps nodes pending until dependencies complete", () => {
    const graph = new PriorityGraph();
    graph.addNode("a", null, { priority: 1 });
    graph.addNode("b", null, { priority: 100, dependsOn: ["a"] });
    expect(graph.get("b")?.state).toBe("pending");
    expect(graph.peek()?.id).toBe("a");

    const a = graph.dequeue();
    expect(a?.state).toBe("in-progress");
    expect(graph.dequeue()).toBeUndefined();
    expect(graph.complete("a")).toEqual(["b"]);
    expect(graph.get("b")?.state).toBe("ready");
    expect(graph.dequeue()?.id).toBe("b");
  });

  it("exposes counts, views and edges", () => {
    const graph = new PriorityGraph<number>();
    graph.addNode("a", 1);
    graph.addNode("b", 2, { dependsOn: ["a"] });
    expect(graph.size).toBe(2);
    expect(graph.count("ready")).toBe(1);
    expect(graph.count("pending")).toBe(1);
    expect(graph.dependenciesOf("b")).toEqual(["a"]);
    expect(graph.dependentsOf("a")).toEqual(["b"]);
    expect(ids(graph.nodes("pending"))).toEqual(["b"]);
    expect(graph.has("a")).toBe(true);
    expect(graph.get("zzz")).toBeUndefined();
  });

  it("validates input", () => {
    const graph = new PriorityGraph();
    graph.addNode("a", null);
    expect(() => graph.addNode("a", null)).toThrow(DuplicateNodeError);
    expect(() => graph.addNode("b", null, { dependsOn: ["missing"] })).toThrow(NodeNotFoundError);
    expect(graph.has("b")).toBe(false);
    expect(() => graph.addNode("c", null, { priority: Number.NaN })).toThrow(TypeError);
    expect(() => graph.addNode("d", null, { dependsOn: "a" as never })).toThrow(TypeError);
    expect(() => graph.setPriority("missing", 1)).toThrow(NodeNotFoundError);
    expect(() => graph.complete("a")).toThrow(InvalidStateError);
    expect(() => graph.requeue("a")).toThrow(InvalidStateError);
  });
});

describe("dynamic changes", () => {
  it("picks up nodes added during traversal", () => {
    const graph = new PriorityGraph<number>();
    graph.addNode("root", 0, { priority: 1 });
    const visited: string[] = [];
    for (const node of graph.traverse()) {
      visited.push(node.id);
      if (node.data < 3) {
        // Children of the current node: they wait for it, then run by priority.
        graph.addNode(`${node.id}.low`, node.data + 1, { priority: 1, dependsOn: [node.id] });
        graph.addNode(`${node.id}.high`, node.data + 1, { priority: 2, dependsOn: [node.id] });
      }
      if (node.id === "root.high") {
        graph.addNode("urgent", 99, { priority: 100 });
      }
    }
    expect(visited.slice(0, 4)).toEqual(["root", "root.high", "urgent", "root.high.high"]);
    expect(visited).toHaveLength(1 + 2 + 4 + 8 + 1);
    expect(graph.isComplete).toBe(true);
  });

  it("can add a dependent of an in-progress node", () => {
    const graph = new PriorityGraph();
    graph.addNode("a", null);
    graph.dequeue();
    graph.addNode("b", null, { dependsOn: ["a"] });
    expect(graph.get("b")?.state).toBe("pending");
    graph.complete("a");
    expect(graph.get("b")?.state).toBe("ready");
  });

  it("treats a dependency on a completed node as satisfied", () => {
    const graph = new PriorityGraph();
    graph.addNode("a", null);
    drain(graph);
    graph.addNode("b", null, { dependsOn: ["a"] });
    expect(graph.get("b")?.state).toBe("ready");
  });

  it("moves a ready node back to pending when it gains a dependency", () => {
    const graph = new PriorityGraph();
    graph.addNode("a", null, { priority: 10 });
    graph.addNode("b", null);
    graph.addDependency("a", "b");
    expect(graph.get("a")?.state).toBe("pending");
    expect(drain(graph)).toEqual(["b", "a"]);
  });

  it("does not let started nodes gain dependencies", () => {
    const graph = new PriorityGraph();
    graph.addNode("a", null);
    graph.addNode("b", null);
    graph.dequeue();
    expect(() => graph.addDependency("a", "b")).toThrow(InvalidStateError);
  });

  it("rejects cycles and reports them", () => {
    const graph = new PriorityGraph();
    graph.addNode("a", null);
    graph.addNode("b", null, { dependsOn: ["a"] });
    graph.addNode("c", null, { dependsOn: ["b"] });
    try {
      graph.addDependency("a", "c");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CycleError);
      expect((error as CycleError).cycle).toEqual(["a", "c", "b", "a"]);
    }
    expect(() => graph.addDependency("a", "a")).toThrow(CycleError);
    expect(graph.dependenciesOf("a")).toEqual([]);
  });

  it("is idempotent when adding an existing edge", () => {
    const graph = new PriorityGraph();
    graph.addNode("a", null);
    graph.addNode("b", null, { dependsOn: ["a"] });
    graph.addDependency("b", "a");
    expect(graph.dependenciesOf("b")).toEqual(["a"]);
  });

  it("unblocks dependents when a dependency edge is removed", () => {
    const graph = new PriorityGraph();
    graph.addNode("a", null);
    graph.addNode("b", null, { dependsOn: ["a"] });
    expect(graph.removeDependency("b", "a")).toBe(true);
    expect(graph.removeDependency("b", "a")).toBe(false);
    expect(graph.get("b")?.state).toBe("ready");
  });

  it("unblocks dependents when a node is removed", () => {
    const graph = new PriorityGraph();
    graph.addNode("a", null);
    graph.addNode("b", null, { dependsOn: ["a"] });
    expect(graph.removeNode("a")).toBe(true);
    expect(graph.removeNode("a")).toBe(false);
    expect(graph.get("b")).toMatchObject({ state: "ready", dependencies: [] });
  });

  it("reorders the queue when priorities change", () => {
    const graph = new PriorityGraph();
    graph.addNode("a", null, { priority: 1 });
    graph.addNode("b", null, { priority: 2 });
    graph.setPriority("a", 3);
    expect(graph.peek()?.id).toBe("a");
  });

  it("supports requeue for retries", () => {
    const graph = new PriorityGraph();
    graph.addNode("a", null, { priority: 1 });
    graph.addNode("b", null, { priority: 2 });
    expect(graph.dequeue()?.id).toBe("b");
    graph.requeue("b");
    expect(graph.dequeue()?.id).toBe("b");
  });

  it("leaves nodes the consumer handled during traversal alone", () => {
    const graph = new PriorityGraph();
    graph.addNode("a", null);
    graph.addNode("b", null);
    for (const node of graph.traverse()) {
      if (node.id === "a") {
        graph.removeNode("a");
      } else {
        graph.complete(node.id);
      }
    }
    expect(ids(graph.nodes())).toEqual(["b"]);
  });

  it("leaves the current node in progress when traversal stops early", () => {
    const graph = new PriorityGraph();
    graph.addNode("a", null);
    for (const _ of graph.traverse()) {
      break;
    }
    expect(graph.get("a")?.state).toBe("in-progress");
  });

  it("prunes completed nodes without affecting the rest", () => {
    const graph = new PriorityGraph();
    graph.addNode("a", null);
    graph.addNode("b", null, { dependsOn: ["a"] });
    graph.addNode("c", null, { dependsOn: ["b"] });
    graph.complete(graph.dequeue()!.id);
    graph.complete(graph.dequeue()!.id);
    expect(graph.pruneCompleted()).toBe(2);
    expect(graph.get("c")).toMatchObject({ state: "ready", dependencies: [] });
  });

  it("updates data", () => {
    const graph = new PriorityGraph<{ n: number }>();
    graph.addNode("a", { n: 1 });
    graph.setData("a", { n: 2 });
    expect(graph.get("a")?.data).toEqual({ n: 2 });
  });
});

describe("priority inheritance", () => {
  it("raises prerequisites of urgent work", () => {
    const graph = new PriorityGraph({ inheritPriority: true });
    graph.addNode("other", null, { priority: 5 });
    graph.addNode("prereq", null, { priority: 1 });
    graph.addNode("urgent", null, { priority: 10, dependsOn: ["prereq"] });
    expect(graph.get("prereq")?.effectivePriority).toBe(10);
    expect(drain(graph)).toEqual(["prereq", "urgent", "other"]);
  });

  it("propagates transitively and lowers again when the dependent goes away", () => {
    const graph = new PriorityGraph({ inheritPriority: true });
    graph.addNode("a", null, { priority: 1 });
    graph.addNode("b", null, { priority: 2, dependsOn: ["a"] });
    graph.addNode("c", null, { priority: 3, dependsOn: ["b"] });
    expect(graph.get("a")?.effectivePriority).toBe(3);
    graph.setPriority("c", 7);
    expect(graph.get("a")?.effectivePriority).toBe(7);
    graph.removeDependency("c", "b");
    expect(graph.get("a")?.effectivePriority).toBe(2);
    graph.removeNode("b");
    expect(graph.get("a")?.effectivePriority).toBe(1);
  });

  it("is off by default", () => {
    const graph = new PriorityGraph();
    graph.addNode("a", null, { priority: 1 });
    graph.addNode("b", null, { priority: 10, dependsOn: ["a"] });
    expect(graph.get("a")?.effectivePriority).toBe(1);
  });
});

describe("snapshots", () => {
  it("round-trips through toSnapshot/fromSnapshot", () => {
    const graph = new PriorityGraph<{ name: string }>({ inheritPriority: true });
    graph.addNode("a", { name: "A" }, { priority: 1 });
    graph.addNode("b", { name: "B" }, { priority: 1 });
    graph.addNode("c", { name: "C" }, { priority: 9, dependsOn: ["b"] });
    graph.addNode("d", { name: "D" }, { priority: 2, dependsOn: ["a"] });
    graph.dequeue();

    const snapshot = JSON.parse(JSON.stringify(graph.toSnapshot()));
    const restored = PriorityGraph.fromSnapshot<{ name: string }>(snapshot, { inheritPriority: true });
    expect(restored.toSnapshot()).toEqual(graph.toSnapshot());
    expect([...restored.nodes()]).toEqual([...graph.nodes()]);
    expect(drain(restored)).toEqual(drain(graph));
    restored.addNode("e", { name: "E" });
    expect(restored.get("e")?.order).toBe(4);
  });

  it("recomputes pending/ready from dependencies", () => {
    const graph = PriorityGraph.fromSnapshot({
      version: 1,
      nodes: [
        { id: "a", data: null, priority: 0, state: "pending", order: 0 },
        { id: "b", data: null, priority: 0, state: "ready", order: 1 },
      ],
      dependencies: [{ id: "b", dependsOn: "a" }],
    });
    expect(graph.get("a")?.state).toBe("ready");
    expect(graph.get("b")?.state).toBe("pending");
  });

  it("rejects invalid snapshots", () => {
    const node = (id: string, order: number, state: NodeState = "ready") => ({
      id,
      data: null,
      priority: 0,
      state,
      order,
    });
    expect(() => PriorityGraph.fromSnapshot({ version: 2 } as never)).toThrow(InvalidSnapshotError);
    expect(() =>
      PriorityGraph.fromSnapshot({ version: 1, nodes: [node("a", 0), node("a", 1)], dependencies: [] }),
    ).toThrow(InvalidSnapshotError);
    expect(() =>
      PriorityGraph.fromSnapshot({ version: 1, nodes: [node("a", 0), node("b", 0)], dependencies: [] }),
    ).toThrow(InvalidSnapshotError);
    expect(() =>
      PriorityGraph.fromSnapshot({
        version: 1,
        nodes: [node("a", 0)],
        dependencies: [{ id: "a", dependsOn: "x" }],
      }),
    ).toThrow(InvalidSnapshotError);
    expect(() =>
      PriorityGraph.fromSnapshot({
        version: 1,
        nodes: [node("a", 0), node("b", 1, "completed")],
        dependencies: [{ id: "b", dependsOn: "a" }],
      }),
    ).toThrow(InvalidSnapshotError);
  });

  it("reports cycles in snapshots", () => {
    const node = (id: string, order: number) =>
      ({ id, data: null, priority: 0, state: "pending", order }) as const;
    try {
      PriorityGraph.fromSnapshot({
        version: 1,
        nodes: [node("x", 0), node("a", 1), node("b", 2)],
        dependencies: [
          { id: "x", dependsOn: "a" },
          { id: "a", dependsOn: "b" },
          { id: "b", dependsOn: "a" },
        ],
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CycleError);
      const { cycle } = error as CycleError;
      expect(cycle[0]).toBe(cycle.at(-1));
      expect(new Set(cycle)).toEqual(new Set(["a", "b"]));
    }
  });
});

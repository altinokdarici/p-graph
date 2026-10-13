# Changelog

## 0.1.0

First release.

- `PriorityGraph`: a dependency-aware priority queue whose nodes and dependencies can change at any time, including during a traversal.
- Labelled edges: typed data on every dependency, persisted with the graph.
- Incremental persistence through an injected `GraphStore`, plus `applyChanges` for document stores.
- Optional priority inheritance, cycle detection, snapshots (`toSnapshot` / `fromSnapshot`).

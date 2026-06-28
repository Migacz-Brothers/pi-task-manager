import type { SubtaskStatus } from './types.ts';

/**
 * The scheduler is a **pure function of (graph, state) → decisions**. It owns no
 * I/O, no SQLite, no docker — only the dependency logic — so it can be tested
 * exhaustively in isolation. Nodes carry just the graph shape; runtime status is
 * supplied separately as a map.
 */
export interface GraphNode {
  slug: string;
  blockedBy: string[];
}

/** Raised when the dependency graph contains a cycle (including self-reference). */
export class GraphCycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Dependency cycle detected: ${cycle.join(' -> ')}`);
    this.name = 'GraphCycleError';
  }
}

/**
 * A dependency in one of these states can never be satisfied, so it blocks its
 * dependents. `blocked` is included because the cascade is transitive: a node
 * blocked by a failed ancestor blocks its own dependents in turn.
 */
export function isBlockingStatus(status: SubtaskStatus | undefined): boolean {
  return (
    status === 'verify_failed' ||
    status === 'harness_error' ||
    status === 'blocked' ||
    status === 'needs_human'
  );
}

function indexBySlug(nodes: GraphNode[]): Map<string, number> {
  const idx = new Map<string, number>();
  nodes.forEach((n, i) => idx.set(n.slug, i));
  return idx;
}

/**
 * Walk the graph depth-first and return the first cycle found as a path
 * (e.g. `['b', 'c', 'b']`), or `null` if the graph is acyclic. Edges to unknown
 * slugs are ignored here — `blockedBy` resolution is the loader's job. A node
 * listing itself is reported as a one-step cycle.
 */
export function findCycle(nodes: GraphNode[]): string[] | null {
  const known = new Set(nodes.map(n => n.slug));
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>(nodes.map(n => [n.slug, WHITE]));
  const bySlug = new Map(nodes.map(n => [n.slug, n]));
  const stack: string[] = [];

  function visit(slug: string): string[] | null {
    color.set(slug, GREY);
    stack.push(slug);
    for (const dep of bySlug.get(slug)!.blockedBy) {
      if (!known.has(dep)) continue; // unresolved edge — loader rejects separately
      if (color.get(dep) === GREY) {
        // Back-edge: slice the stack from the re-entered node and close the loop.
        return [...stack.slice(stack.indexOf(dep)), dep];
      }
      if (color.get(dep) === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(slug, BLACK);
    return null;
  }

  for (const n of nodes) {
    if (color.get(n.slug) === WHITE) {
      const found = visit(n.slug);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Topological order over the graph, with the node's position in `nodes` (the
 * `NN-` filename order) as a deterministic tiebreaker among nodes that are
 * simultaneously ready. Kahn's algorithm, always emitting the available node
 * with the smallest input index. Throws {@link GraphCycleError} on a cycle.
 */
export function topologicalOrder(nodes: GraphNode[]): string[] {
  const idx = indexBySlug(nodes);
  // Count each distinct, resolvable dependency once.
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    dependents.set(n.slug, dependents.get(n.slug) ?? []);
    const deps = new Set(n.blockedBy.filter(d => idx.has(d)));
    indegree.set(n.slug, deps.size);
    for (const d of deps) {
      const list = dependents.get(d) ?? [];
      list.push(n.slug);
      dependents.set(d, list);
    }
  }

  // Ready = indegree 0, kept sorted by input index so ties break by `NN-`.
  const ready = nodes.filter(n => indegree.get(n.slug) === 0).map(n => n.slug);
  ready.sort((a, b) => idx.get(a)! - idx.get(b)!);

  const order: string[] = [];
  while (ready.length > 0) {
    const slug = ready.shift()!;
    order.push(slug);
    for (const dep of dependents.get(slug) ?? []) {
      const next = indegree.get(dep)! - 1;
      indegree.set(dep, next);
      if (next === 0) {
        // Insert preserving the input-index ordering of the ready frontier.
        const at = ready.findIndex(s => idx.get(s)! > idx.get(dep)!);
        if (at === -1) ready.push(dep);
        else ready.splice(at, 0, dep);
      }
    }
  }

  if (order.length !== nodes.length) {
    throw new GraphCycleError(findCycle(nodes) ?? []);
  }
  return order;
}

/** A pure scheduling decision derived from the graph and current runtime state. */
export interface Decision {
  /** Full topological order (NN- tiebreak). */
  order: string[];
  /** Pending subtasks whose every dependency has `passed`, in topological order. */
  runnable: string[];
  /**
   * Pending subtasks with at least one dependency that ended in a blocking
   * state — the transitive cascade. These should be marked `blocked`.
   */
  blocked: string[];
}

/**
 * Compute the runnable set and the blocked cascade from the graph plus a
 * snapshot of each subtask's status. Statuses absent from the map are treated as
 * `pending`. Pure: same inputs always yield the same decision.
 */
export function schedule(
  nodes: GraphNode[],
  status: ReadonlyMap<string, SubtaskStatus>
): Decision {
  const order = topologicalOrder(nodes);
  const bySlug = new Map(nodes.map(n => [n.slug, n]));
  const statusOf = (slug: string): SubtaskStatus => status.get(slug) ?? 'pending';

  // Cascade in topological order so a dependency's blocked decision is known
  // before its dependents are examined — yielding the full transitive closure.
  const blocked = new Set<string>();
  for (const slug of order) {
    if (statusOf(slug) !== 'pending') continue;
    const deps = bySlug.get(slug)!.blockedBy;
    const cascades = deps.some(d => blocked.has(d) || isBlockingStatus(statusOf(d)));
    if (cascades) blocked.add(slug);
  }

  const runnable = order.filter(slug => {
    if (statusOf(slug) !== 'pending' || blocked.has(slug)) return false;
    return bySlug.get(slug)!.blockedBy.every(d => statusOf(d) === 'passed');
  });

  return { order, runnable, blocked: [...blocked] };
}

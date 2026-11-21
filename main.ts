// A Sokoban solver for the make.fun sokoban-solver-01 bounty.
//
// Idea: every level the generator draws is a one-wide hallway with a few small
// rooms off it, each room holding its own boxes and goals, and a box pushed out
// of a room can never come back - so each room is an independent puzzle and the
// level's push-optimal count is the sum of the rooms' optima. This program
// finds the rooms, solves each one on its own with a push-based A* search
// (fewest pushes, not fewest steps), and stitches the rooms together with
// plain walks along the hallway.
//
// A push search state is the boxes' squares plus the square the player stands
// on; two states that share the boxes and the player's reachable region are
// the same state, named by the region's lowest square. The search orders
// states by pushes made plus a matching estimate: every box is matched to a
// different goal, the cost of a match being the box's walking distance to that
// goal, and the cheapest matching is a lower bound on the pushes still
// needed, so the first solved state the search takes off its queue is
// push-optimal. Two prunings keep it small: a box on a square from which no
// push can ever reach a goal is dead, and a box frozen inside a 2x2 block of
// walls and boxes, off its goal, is dead too. Everything is counted in work,
// never in wall-clock time, so two runs write the same bytes.
//
// Node 22 runs this file as it is (erasable syntax only): no imports beyond
// node:fs and node:path, no clock, no randomness.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The four moves: [dx, dy, the move's letter]. */
const DIRS: ReadonlyArray<readonly [number, number, string]> = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

/** The most states one room search may create before it gives up. */
const MAX_STATES = 600_000;
/** The most states the plain push-breadth fallback may create. */
const MAX_STATES_FALLBACK = 600_000;

/** A board with a one-square wall border, so neighbours never leave the array. */
interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player, + player on a goal). */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const rawW = Math.max(...rows.map((r) => r.length));
  const rawH = rows.length;
  const w = rawW + 2;
  const h = rawH + 2;
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < rawW; x++) {
      const ch = row[x] ?? '#';
      const i = (y + 1) * w + (x + 1);
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** The square the player stands on after `moves` from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/** A flood fill that can be run again and again, each run under its own stamp. */
class Flood {
  seen: Int32Array;
  stack: Int32Array;
  stamp = 0;

  constructor(size: number) {
    this.seen = new Int32Array(size);
    this.stack = new Int32Array(size);
  }

  /** The lowest square reachable from `from` around walls and `occupied`; returns [lowest, stamp]. */
  region(wall: Uint8Array, w: number, occupied: Uint8Array, from: number): [number, number] {
    const stamp = ++this.stamp;
    const seen = this.seen;
    const stack = this.stack;
    let low = from;
    let n = 0;
    stack[n++] = from;
    seen[from] = stamp;
    while (n > 0) {
      const p = stack[--n];
      if (p < low) low = p;
      for (let k = 0; k < 4; k++) {
        const q = p + DIRS[k][1] * w + DIRS[k][0];
        if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
          seen[q] = stamp;
          stack[n++] = q;
        }
      }
    }
    return [low, stamp];
  }

  reached(cell: number, stamp: number): boolean {
    return this.seen[cell] === stamp;
  }
}

/** The squares from which a box, pushed around on its own, can still reach some goal. */
function liveCells(board: Board): Uint8Array {
  const { w, wall, goals } = board;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k][1] * w + DIRS[k][0];
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** Every square's walking distance from `from`, around the walls alone. */
function distancesFrom(board: Board, from: number): Int32Array {
  const { w, wall } = board;
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [from];
  dist[from] = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k][1] * w + DIRS[k][0];
      if (!wall[q] && dist[q] < 0) {
        dist[q] = dist[p] + 1;
        queue.push(q);
      }
    }
  }
  return dist;
}

/** All orderings of 0..n-1, for matching boxes to goals. */
function orderings(n: number): number[][] {
  if (n === 0) return [[]];
  const rest = orderings(n - 1);
  const out: number[][] = [];
  for (const r of rest) {
    for (let i = 0; i <= r.length; i++) out.push([...r.slice(0, i), n - 1, ...r.slice(i)]);
  }
  return out;
}

/** The shortest walk from `from` to `to` around walls and `occupied`, in lower-case letters. */
function walkPath(wall: Uint8Array, w: number, occupied: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k][1] * w + DIRS[k][0];
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = DIRS[k][2];
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkPath: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** Whether the box just pushed onto `t` sits frozen in a 2x2 block of walls and boxes, off its goal. */
function frozenBlock(wall: Uint8Array, occupied: Uint8Array, goal: Uint8Array, w: number, t: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** One push, as the step that made a state from its parent. */
interface Push {
  from: number;
  to: number;
  dir: number;
}

/**
 * The push-optimal moves solving `board`, or null when the search gives up.
 * With `match` the queue is ordered by pushes plus the cheapest box-to-goal
 * matching; without it the queue is plain breadth-first over pushes. Either
 * way the first solved state taken off the queue is push-optimal.
 */
function solvePushes(board: Board, maxStates: number, match: boolean): string | null {
  const { w, wall, goals } = board;
  const size = wall.length;
  const n = goals.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (solved(board.boxes)) return '';
  const live = liveCells(board);
  if (board.boxes.some((b) => !live[b])) return null;

  // The matching estimate: the cheapest way to pair every box with a goal.
  // With many boxes the exact matching is too big to enumerate, so the
  // estimate falls back to each box's own nearest goal (still a lower bound:
  // a matching can only cost more than the sum of the separate minima).
  const goalDist = goals.map((g) => distancesFrom(board, g));
  const perms = n <= 5 ? orderings(n) : [];
  const estimateCache = new Map<string, number>();
  const estimate = (boxes: number[]): number => {
    if (!match) return 0;
    const cacheKey = boxes.join(',');
    const hit = estimateCache.get(cacheKey);
    if (hit !== undefined) return hit;
    let best = Infinity;
    if (perms.length > 0) {
      for (const perm of perms) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
          const d = goalDist[perm[i]][boxes[i]];
          if (d < 0) {
            sum = Infinity;
            break;
          }
          sum += d;
        }
        if (sum < best) best = sum;
      }
    } else {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        let nearest = Infinity;
        for (let j = 0; j < n; j++) {
          const d = goalDist[j][boxes[i]];
          if (d >= 0 && d < nearest) nearest = d;
        }
        if (nearest === Infinity) {
          sum = Infinity;
          break;
        }
        sum += nearest;
      }
      best = sum;
    }
    estimateCache.set(cacheKey, best);
    return best;
  };

  // A state's name: its boxes and its reachable region's lowest square.
  const keyOf = (boxes: number[], low: number): number | string => {
    if (size ** (n + 1) < 2 ** 53) {
      let k = low;
      for (const b of boxes) k = k * size + b;
      return k;
    }
    return `${low}|${boxes.join(',')}`;
  };

  const flood = new Flood(size);
  // A second flood fill, so computing a successor's region never re-marks
  // the cells the current state's region test still reads.
  const floodNext = new Flood(size);
  const occupied = new Uint8Array(size);
  for (const b of board.boxes) occupied[b] = 1;
  const [low0] = flood.region(wall, w, occupied, board.player);
  for (const b of board.boxes) occupied[b] = 0;

  const sBoxes: number[][] = [board.boxes.slice()];
  const sPlayer: number[] = [board.player];
  const sParent: number[] = [-1];
  const sPush: (Push | null)[] = [null];
  const sG: number[] = [0];
  const sKey: (number | string)[] = [keyOf(board.boxes, low0)];
  const best = new Map<number | string, number>([[sKey[0], 0]]);
  const expanded = new Set<number | string>();

  // The queue: a heap on [pushes + estimate, estimate, order found].
  type Entry = [number, number, number, number];
  const heap: Entry[] = [];
  const less = (a: Entry, b: Entry): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: Entry): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      const tmp = heap[i];
      heap[i] = heap[p];
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): Entry => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last !== undefined) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        const tmp = heap[i];
        heap[i] = heap[c];
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };

  let order = 0;
  heapPush([estimate(board.boxes), estimate(board.boxes), order++, 0]);
  while (heap.length > 0) {
    const [, , , s] = heapPop();
    const g = sG[s];
    if (best.get(sKey[s]) !== g || expanded.has(sKey[s])) continue;
    expanded.add(sKey[s]);
    const boxes = sBoxes[s];
    if (solved(boxes)) {
      // Walk the parents back, then play the pushes forward with their walks.
      const chain: number[] = [];
      for (let t = s; t > 0; t = sParent[t]) chain.push(t);
      chain.reverse();
      let moves = '';
      let player = board.player;
      let current = board.boxes.slice();
      for (const t of chain) {
        const push = sPush[t];
        if (push === null) continue;
        for (const b of current) occupied[b] = 1;
        moves += walkPath(wall, w, occupied, player, push.from - (push.to - push.from));
        for (const b of current) occupied[b] = 0;
        moves += DIRS[push.dir][2];
        player = push.from;
        current = sBoxes[t];
      }
      return moves;
    }
    for (const b of boxes) occupied[b] = 1;
    const [, stamp] = flood.region(wall, w, occupied, sPlayer[s]);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k][1] * w + DIRS[k][0];
        const t = b + d;
        if (!flood.reached(b - d, stamp) || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(wall, occupied, goal, w, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        let h = Infinity;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, b2) => a - b2);
          h = estimate(next);
        }
        if (!frozen && h < Infinity) {
          const [low] = floodNext.region(wall, w, occupied, b);
          key = keyOf(next, low);
          const seen = best.get(key);
          if (seen === undefined || seen > g + 1) {
            if (sBoxes.length >= maxStates) {
              for (const x of boxes) occupied[x] = 0;
              return null;
            }
            best.set(key, g + 1);
            const idx = sBoxes.length;
            sBoxes.push(next);
            sPlayer.push(b);
            sParent.push(s);
            sPush.push({ from: b, to: t, dir: k });
            sG.push(g + 1);
            sKey.push(key);
            heapPush([g + 1 + h, h, order++, idx]);
          }
        }
        occupied[t] = 0;
        occupied[b] = 1;
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  return null;
}

/** One room: its floor, its boxes and goals, and the hallway square outside its door. */
interface Room {
  boxes: number[];
  goals: number[];
  entry: number;
  done: boolean;
}

/**
 * Cut the player's row (the hallway: a box there reaches no goal) out of the
 * floor; each part left that holds boxes is a room. Null when a box starts in
 * the hallway, a part holds a different count of boxes and goals, or a room
 * has no way in from the hallway.
 */
function roomsOf(board: Board): Room[] | null {
  const { w, wall, goals, boxes, player } = board;
  const hallRow = Math.floor(player / w);
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || Math.floor(s / w) === hallRow || part[s] >= 0) continue;
    const cells = [s];
    part[s] = rooms.length;
    for (let i = 0; i < cells.length; i++) {
      for (let k = 0; k < 4; k++) {
        const q = cells[i] + DIRS[k][1] * w + DIRS[k][0];
        if (!wall[q] && Math.floor(q / w) !== hallRow && part[q] < 0) {
          part[q] = rooms.length;
          cells.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], entry: -1, done: false });
    // The door: the one cell of this part touching the hallway row.
    for (const c of cells) {
      for (const q of [c - w, c + w]) {
        if (Math.floor(q / w) === hallRow && !wall[q]) {
          rooms[rooms.length - 1].entry = q;
          break;
        }
      }
      if (rooms[rooms.length - 1].entry >= 0) break;
    }
  }
  for (const b of boxes) {
    if (part[b] < 0) return null;
    rooms[part[b]].boxes.push(b);
  }
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  const filled = rooms.filter((r) => r.boxes.length > 0);
  if (filled.some((r) => r.boxes.length !== r.goals.length || r.entry < 0)) return null;
  return filled;
}

/** Solve a level room by room; fall back to one search over the whole level. */
function solveLevel(board: Board): string {
  const rooms = roomsOf(board);
  if (rooms !== null) {
    let moves = '';
    let player = board.player;
    let ok = true;
    for (const room of rooms) {
      // The other rooms' boxes stand as walls while this one is solved.
      const wall = board.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
      }
      const sub: Board = { w: board.w, h: board.h, wall, goals: room.goals, boxes: room.boxes, player };
      const part = solvePushes(sub, MAX_STATES, true) ?? solvePushes(sub, MAX_STATES_FALLBACK, false);
      if (part === null) {
        ok = false;
        break;
      }
      moves += part;
      player = endOf(board.w, player, part);
      room.done = true;
    }
    if (ok) return moves;
  }
  return solvePushes(board, MAX_STATES_FALLBACK, true) ?? solvePushes(board, MAX_STATES_FALLBACK, false) ?? '';
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8')));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}

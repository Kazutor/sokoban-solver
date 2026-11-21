# Sokoban Solver — make.fun bounty entry

[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-7c5cff)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-339933)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A push-optimal Sokoban solver for the [make.fun bounty "Build the best Sokoban solver, 21 November 2026"](https://make.fun/bounty/sokoban-solver-01-run-20261121).

## How it works

Every level the generator draws is a one-wide hallway with a few small rooms
off it, each room holding its own boxes and goals, and a box pushed out of a
room can never come back — so each room is an independent puzzle and the
level's push-optimal count is the sum of the rooms' optima. This program:

1. **Finds the rooms** — the connected parts of the floor once the player's
   (hallway) row is cut out.
2. **Solves each room on its own** with a push-based A* search: a state is
   the boxes' squares plus the player's reachable region, ordered by pushes
   made plus a cheapest box-to-goal matching estimate, so the first solved
   state off the queue is push-optimal. Dead squares (from which no push can
   ever reach a goal) and frozen 2×2 blocks of walls and boxes are pruned.
3. **Stitches the rooms together** with plain walks along the hallway, the
   other rooms' boxes standing as walls while one room is solved.

The search budget is counted in states created, never in wall-clock time, so
two runs write byte-identical answers. It runs on Node 22 as it is (erasable
TypeScript only, `node:fs` / `node:path` only, no clock, no randomness).

## Results

| Set | Score | Per instance (pushes vs P*) |
| --- | --- | --- |
| Practice set | **1,000,000** | i001 13/13, i002 16/16, i003 29/29, i004 47/47, i005 60/60 |
| House baseline (plain-astar 1.0.0) | 200,000 | solves only i001 |
| Two extra sets drawn from drand quicknet round 34152036 | **1,000,000** each | every instance at P*, including a 22-push room |

Whole-set runtime is well under a second locally, far inside the 60-second
wall budget.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

It reads `<input>/<id>/level.txt` and writes `<output>/<id>/solution.txt`
for every instance.

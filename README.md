# Meridian

A living globe for the [PPM](https://github.com/drQedwards/PPM) solution engine.

Pick two cities. The day rolls in UTC, and the corridor recomputes as local rush hour inflates cruise time at both ends. Routes are remembered the same way PPM resolves a query: a short-term peek, then the long-term graph, then a fresh solve that gets cached. Drag the globe to turn it. Play walks the clock so the winning path can change.

## Run

```bash
npm install
npm run dev
```

The dev server listens on port 8080.

`npm run build` produces the production bundle. `npm run typecheck` runs the TypeScript check.

## What it solves

Edge cost is flight time, not raw distance. A hop is kept only when it still makes progress toward the destination. Scoring follows the PMLL memory graph: similarity gate `0.72`, temporal decay, and promotion from short-term memory into the long-term graph after repeated hits.

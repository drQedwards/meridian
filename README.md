# Meridian

A living globe for the [PPM](https://github.com/drQedwards/PPM) solution engine, grained to the United States one state at a time. Florida is first.

Pick two Florida places. The clock steps in 15-minute slices of Eastern time. Counted trips — commute, visitors, through traffic — load the highways. Selfish drivers take the cheapest path still open. A coordinator minimizes total vehicle-hours. The ratio is the price of anarchy, and it moves through the day. The route you see is the path carrying those vehicles.

Drag the globe to turn it. Play walks the day a quarter hour at a time.

## Run

```bash
npm install
npm run dev
```

The dev server listens on port 8080.

`npm run build` produces the production bundle. `npm run typecheck` runs the TypeScript check.

## What it solves

Link time is a BPR curve. Path flows add up to the trips between a pair, and a road's vehicles are the paths that use it. Scoring for remembered routes still follows the PMLL memory graph: similarity gate `0.72`, temporal decay, and promotion from short-term memory into the long-term graph after repeated hits.

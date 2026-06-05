import { sizeUnitsBased } from "../lib/units-math.ts";

const result = sizeUnitsBased({
  anchor: 1000,
  filters: [0.5, 0.2],
  unitPrice: 100,
  replacementRate: 0.25,
});

console.log(JSON.stringify(result, null, 2));

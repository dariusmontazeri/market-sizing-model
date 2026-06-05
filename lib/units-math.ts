export const PENETRATION = { bear: 0.01, base: 0.03, bull: 0.05 } as const;

const ANNUAL_CADENCE_THRESHOLD = 0.9;

export type FilterStep = {
  index: number;
  rate: number;
  countBefore: number;
  countAfter: number;
};

export type SomColumn = {
  somDollars: number;
  replacementDollars: number;
  totalWithReplacement: number;
};

export type SizingInput = {
  anchor: number;
  filters: number[];
  unitPrice: number;
  replacementRate: number;
};

export type SizingResult = {
  inputs: SizingInput;
  filterChain: FilterStep[];
  samUnits: number;
  samDollars: number;
  penetration: { bear: number; base: number; bull: number };
  som: { bear: SomColumn; base: SomColumn; bull: SomColumn };
  replacementHonestyCheck: {
    replacementRate: number;
    flag: boolean;
    note: string;
  };
};

export function sizeUnitsBased(input: SizingInput): SizingResult {
  const { anchor, filters, unitPrice, replacementRate } = input;

  const filterChain: FilterStep[] = [];
  let runningCount = anchor;
  filters.forEach((rate, i) => {
    const countBefore = runningCount;
    const countAfter = countBefore * rate;
    filterChain.push({ index: i, rate, countBefore, countAfter });
    runningCount = countAfter;
  });

  const samUnits = runningCount;
  const samDollars = samUnits * unitPrice;

  const buildSom = (penRate: number): SomColumn => {
    const somDollars = samDollars * penRate;
    const replacementDollars = somDollars * replacementRate;
    return {
      somDollars,
      replacementDollars,
      totalWithReplacement: somDollars + replacementDollars,
    };
  };

  const annualish = replacementRate >= ANNUAL_CADENCE_THRESHOLD;

  return {
    inputs: input,
    filterChain,
    samUnits,
    samDollars,
    penetration: { ...PENETRATION },
    som: {
      bear: buildSom(PENETRATION.bear),
      base: buildSom(PENETRATION.base),
      bull: buildSom(PENETRATION.bull),
    },
    replacementHonestyCheck: {
      replacementRate,
      flag: annualish,
      note: annualish
        ? `replacementRate=${replacementRate} implies an effectively annual cadence (>= ${ANNUAL_CADENCE_THRESHOLD}). The recurring layer is roughly redundant with SOM and risks double-counting; verify SOM is not already annual.`
        : `replacementRate=${replacementRate} represents a recurring layer distinct from SOM.`,
    },
  };
}

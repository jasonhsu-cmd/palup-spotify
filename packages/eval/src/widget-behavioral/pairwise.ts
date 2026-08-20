export type AxisSpec = Record<string, string[]>;

export function allPairs(axes: AxisSpec): Record<string, string>[] {
  const names = Object.keys(axes);
  const need = new Set<string>();

  const pairKey = (a: string, va: string, b: string, vb: string) => {
    const [x, xv, y, yv] = a < b ? [a, va, b, vb] : [b, vb, a, va];
    return `${x}=${xv}|${y}=${yv}`;
  };

  // Build set of all required pairs
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i]!;
      const b = names[j]!;
      for (const va of axes[a]!) {
        for (const vb of axes[b]!) {
          need.add(pairKey(a, va, b, vb));
        }
      }
    }
  }

  const rows: Record<string, string>[] = [];
  const usage: Record<string, Record<string, number>> = {};
  for (const axis of names) {
    usage[axis] = {};
    for (const val of axes[axis]!) {
      usage[axis]![val] = 0;
    }
  }

  while (need.size > 0) {
    const row: Record<string, string> = {};

    // For each axis in order, greedily pick a value
    for (let i = 0; i < names.length; i++) {
      const axis = names[i]!;
      let bestVal = axes[axis]![0]!;
      let bestGain = -1;
      let bestUsage = Infinity;

      // Try each possible value for this axis
      for (const v of axes[axis]!) {
        let gain = 0;

        // Count uncovered pairs with axes assigned earlier
        for (let prevIdx = 0; prevIdx < i; prevIdx++) {
          const prevAxis = names[prevIdx]!;
          const prevVal = row[prevAxis]!;
          const key = pairKey(prevAxis, prevVal, axis, v);
          if (need.has(key)) gain++;
        }

        // Tie-breaker: prefer less-used values
        const currentUsage = usage[axis]![v]!;
        if (gain > bestGain || (gain === bestGain && currentUsage < bestUsage)) {
          bestGain = gain;
          bestVal = v;
          bestUsage = currentUsage;
        }
      }

      row[axis] = bestVal;
      usage[axis]![bestVal]!++;
    }

    // Remove all covered pairs
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = names[i]!;
        const b = names[j]!;
        const key = pairKey(a, row[a]!, b, row[b]!);
        need.delete(key);
      }
    }

    rows.push(row);
  }

  return rows;
}

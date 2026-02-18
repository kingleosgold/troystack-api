# Stack Tracker Gold v2.1 — Widget Fixes Spec
# Give this to Claude Code for implementation

## Bug 1: Widget Data Consistency (CRITICAL)
**Problem:** Widget shows green sparkline (trending up) but red daily P/L (negative). 
The sparkline and daily change number are calculated from different cached data snapshots.

**Root Cause:** The sparkline data points and the daily P/L baseline (previous close) 
are fetched/cached independently. When one updates before the other, they show 
contradicting information.

**Fix:** Create an atomic `WidgetDataSnapshot` struct that bundles:
- currentValue: Double (portfolio value right now)
- previousCloseValue: Double (portfolio value at market close yesterday)
- dailyChange: Double (currentValue - previousCloseValue)
- dailyChangePct: Double
- sparklinePoints: [Double] (intraday values)
- spotPrices: SpotPrices (Au, Ag, Pt, Pd)
- timestamp: Date

Both the sparkline and the P/L MUST come from this single snapshot.
Never mix a fresh sparkline with a stale P/L or vice versa.

The sign/color of dailyChange must ALWAYS match the sparkline trend direction.
If sparkline shows upward → green, dailyChange must be positive.
If sparkline shows downward → red, dailyChange must be negative.

**Validation:** Before displaying, add a sanity check:
```swift
// If sparkline trend and P/L sign disagree, force recalculate from same data
let sparklineTrend = sparklinePoints.last > sparklinePoints.first
let plIsPositive = dailyChange >= 0
if sparklineTrend != plIsPositive {
    // Recalculate dailyChange from sparkline endpoints
    dailyChange = sparklinePoints.last - sparklinePoints.first
}
```

## Bug 2: Medium Widget Layout Redesign
**Current:** Side-by-side layout (Portfolio left | Spot right) with wasted space under Ag

**New layout (vertical stack like top half of large widget):**
```
┌─────────────────────────────────┐
│ PORTFOLIO                       │
│ $489,946        ▲ +$13,491      │
│ ─────── sparkline ──────────    │
│─────────────────────────────────│
│ ● Au  $4,925  +1.0%  ~~~       │
│ ● Ag  $75.63  +3.4%  ~~~       │
└─────────────────────────────────┘
```

- Portfolio value large on top with change amount/percent
- Full-width sparkline below the portfolio value
- Gold + Silver in a row below with wider sparklines
- Match the large widget's visual style

## Additional: Widget Refresh Timing
- Ensure the widget timeline provider refreshes at consistent intervals
- After each refresh, ALL data (sparkline + P/L + prices) must come from 
  the same fetch cycle — no partial updates

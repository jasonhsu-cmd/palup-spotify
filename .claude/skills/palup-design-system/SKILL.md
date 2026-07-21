---
name: palup-design-system
description: >-
  Load whenever building or editing PalUp UI (merchant console, admin console, or any
  shared component). Provides the canonical design tokens (verified identical across both
  consoles), the Tailwind theme mapping, and the component vocabulary. Use before writing
  any React/Tailwind/shadcn-ui code so colors, spacing, radii, shadows, and typography stay
  consistent with the HTML mockups.
---

# PalUp Design System (for Claude Code)

The HTML mockups `palup-merchant-app.html` and `palup-admin-console.html` are the visual
source of truth. Their `:root` token sets are identical. Full narrative:
`docs/DESIGN-SYSTEM.md`. Machine-readable tokens: `tokens.css` (next to this file).

## How to use
1. Import `tokens.css` (CSS variables) at the app root, OR map the tokens into the Tailwind
   theme (snippet below) so utilities like `bg-ever`, `text-ink-3`, `rounded-lg`,
   `shadow-sm` resolve to PalUp values.
2. Wrap shadcn/ui primitives with these tokens; do not restyle per-use.
3. Never hand-write a hex or magic spacing value. If a new value is truly needed, add it to
   `tokens.css` and record it in `docs/DESIGN-SYSTEM.md`.
4. Build and verify every view at desktop AND the mobile off-canvas drawer breakpoint.

## Tailwind theme mapping (tailwind.config.js `theme.extend`)
```js
colors: {
  ink:{DEFAULT:'#16201B','2':'#3D4A43','3':'#677269','4':'#94A09A'},
  paper:'#F6F7F3',
  surface:{DEFAULT:'#FFFFFF','2':'#FBFCF9','3':'#F0F2EC'},
  line:{DEFAULT:'#E4E7DF','2':'#EEF0EA'},
  ever:{DEFAULT:'#0C4A3C','2':'#0E5A48',soft:'#E6F0EB',tint:'#F1F6F3'},
  coral:{DEFAULT:'#FF5C35',soft:'#FFE9E2'},
  gold:{DEFAULT:'#B8852A',soft:'#FBF1DC'},
  pos:{DEFAULT:'#0E8F5E',soft:'#E4F4EC'},
  warn:{DEFAULT:'#C9810C',soft:'#FBF0D9'},
  dang:{DEFAULT:'#D33B2C',soft:'#FBE7E4'},
  info:{DEFAULT:'#2B66D9',soft:'#E6EEFB'},
},
borderRadius:{sm:'8px',DEFAULT:'12px',lg:'18px',xl:'26px'},
fontFamily:{
  sans:['"Hanken Grotesk"','system-ui','sans-serif'],
  display:['"Schibsted Grotesk"','system-ui','sans-serif'],
  mono:['"IBM Plex Mono"','ui-monospace','monospace'],
},
boxShadow:{
  sm:'0 1px 2px rgba(22,32,27,.06),0 1px 1px rgba(22,32,27,.04)',
  DEFAULT:'0 2px 8px rgba(22,32,27,.06),0 1px 2px rgba(22,32,27,.04)',
  lg:'0 18px 48px -12px rgba(22,32,27,.20),0 6px 16px -8px rgba(22,32,27,.12)',
},
```

## Component vocabulary
Shell (dark `ink` sidebar + `paper` content, sidebar width 264px, collapses to off-canvas
drawer < ~900px) · grouped nav with uppercase group titles + active state + coral attention
dot · `card` · `stat` metric tiles · `btn` (`primary` evergreen / `outline` / `sm`) ·
status `bdg` (pos/warn/dang/gray/info) · `tabs` · inputs with evergreen focus ring · toggle
`sw` · right-side detail drawer · `note` callouts (warn/info) · toast.

Governance surfaces (Approval Center, Kill Switch, Evolution Console, Eval Dashboard, Audit
Log) are safety-critical: approve/deny/halt/rollback must be obvious and hard to misclick.

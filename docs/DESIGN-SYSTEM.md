# PalUp Design System

Both consoles (`palup-merchant-app.html`, `palup-admin-console.html`) ship an **identical**
`:root` token set (verified by diff). This document is the canonical record of those tokens
so UI work stays consistent across merchant and admin surfaces. The full machine-readable
version lives in the `palup-design-system` skill for Claude Code to load on demand.

## Direction

Professional, light-toned, high legibility, calm interactions. Evergreen (deep green) is
the brand/primary; coral and gold are accents; a warm off-white "paper" is the canvas.
Mobile and desktop are both first-class (the sidebar collapses to an off-canvas drawer at
narrow widths).

## Color tokens

| Token | Value | Use |
|---|---|---|
| `--ink` | `#16201B` | Primary text, dark sidebar bg |
| `--ink-2` | `#3D4A43` | Secondary text |
| `--ink-3` | `#677269` | Tertiary/muted text |
| `--ink-4` | `#94A09A` | Faint text, placeholders |
| `--paper` | `#F6F7F3` | App canvas background |
| `--surface` | `#FFFFFF` | Cards, panels |
| `--surface-2` | `#FBFCF9` | Subtle raised surface |
| `--surface-3` | `#F0F2EC` | Insets, wells |
| `--line` | `#E4E7DF` | Borders |
| `--line-2` | `#EEF0EA` | Faint dividers |
| `--ever` | `#0C4A3C` | **Primary / brand** |
| `--ever-2` | `#0E5A48` | Primary hover |
| `--ever-soft` | `#E6F0EB` | Primary tint bg |
| `--ever-tint` | `#F1F6F3` | Focus ring / very soft tint |
| `--coral` | `#FF5C35` | Accent, attention dots |
| `--coral-soft` | `#FFE9E2` | Coral tint bg |
| `--gold` | `#B8852A` | Accent (high-stakes tier, premium) |
| `--gold-soft` | `#FBF1DC` | Gold tint bg |
| `--pos` | `#0E8F5E` | Positive/success |
| `--pos-soft` | `#E4F4EC` | Success tint |
| `--warn` | `#C9810C` | Warning |
| `--warn-soft` | `#FBF0D9` | Warning tint |
| `--dang` | `#D33B2C` | Danger/error, kill actions |
| `--dang-soft` | `#FBE7E4` | Danger tint |
| `--info` | `#2B66D9` | Informational |
| `--info-soft` | `#E6EEFB` | Info tint |

## Radii, shadow, layout

| Token | Value |
|---|---|
| `--r-sm` / `--r` / `--r-lg` / `--r-xl` | `8px` / `12px` / `18px` / `26px` |
| `--sh-sm` | `0 1px 2px rgba(22,32,27,.06),0 1px 1px rgba(22,32,27,.04)` |
| `--sh` | `0 2px 8px rgba(22,32,27,.06),0 1px 2px rgba(22,32,27,.04)` |
| `--sh-lg` | `0 18px 48px -12px rgba(22,32,27,.20),0 6px 16px -8px rgba(22,32,27,.12)` |
| `--sidebar-w` | `264px` |

## Typography

| Token | Family | Role |
|---|---|---|
| `--ff` | `"Hanken Grotesk", system-ui, sans-serif` | Body |
| `--fd` | `"Schibsted Grotesk", system-ui, sans-serif` | Display / headings / brand |
| `--fm` | `"IBM Plex Mono", ui-monospace, monospace` | Numbers, metrics (`.mono`, tabular-nums) |

Base body: 14px / line-height 1.5, antialiased. Headings use `--fd`, weight 700,
letter-spacing `-.01em`.

## Component vocabulary (from the mockups)

- **App shell:** dark sidebar (`--ink`) + `--paper` content, `grid-template-columns:
  var(--sidebar-w) 1fr`. Under ~900px the sidebar becomes a fixed off-canvas drawer.
- **Nav:** grouped links with uppercase group titles (`.grp-t`), active state, coral dot
  for attention.
- **`.card`** (surface + `--line` + `--r-lg` + `--sh-sm`), **`.stat`** metric tiles,
  **`.btn`** with `.primary` (evergreen) / `.outline` / `.sm` variants, **`.bdg`** status
  badges (`pos/warn/dang/gray/info`), **`.tabs`**, **`.inp/.sel/.txa`** with evergreen focus
  ring, **`.sw`** toggle, right-side **drawer** for detail, **`.note`** callouts
  (warn/info), toast.

## Rules for building the real UI

1. **Never introduce a raw hex or ad-hoc spacing** — use tokens. Extend the tokens file and
   note it here if a genuinely new value is needed.
2. **Map tokens → Tailwind theme** so `bg-ever`, `text-ink-3`, `rounded-lg` etc. resolve to
   these values; wrap shadcn/ui primitives with these tokens rather than restyling per use.
3. **Match the mockups** for layout and component behavior — they are the visual source of
   truth. When in doubt, open the HTML and mirror it.
4. **Both breakpoints always.** Verify desktop and the mobile off-canvas drawer for every
   view.

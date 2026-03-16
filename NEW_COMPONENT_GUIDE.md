# How to Add a New Page Component

## Architecture Overview

```
AppProvider  (src/AppContext.tsx)
└── App  (src/App.tsx)
    ├── AppSidebar        ← memoized, owns auth state (Upstox / Nubra / Dhan / Cookie)
    ├── AppNavbar         ← memoized, reads page + basket from context
    └── <main>
        ├── WorkspaceRoot   (chart)
        ├── StraddleChart   (straddle)
        ├── NubraApiTester  (nubra)
        ├── HistoricalWorkspace (historical)
        ├── OIProfileView   (oiprofile)
        ├── Backtest        (backtest)
        └── MtmLayout       (mtm)
```

---

## Step-by-Step Checklist

### Step 1 — Register the page name
**File:** `src/AppContext.tsx` line 10

```ts
export type Page = 'chart' | 'straddle' | 'oiprofile' | 'nubra' | 'backtest' | 'historical' | 'mtm' | 'yourpage';
```

---

### Step 2 — Add a sidebar nav item
**File:** `src/App.tsx` → inside `AppSidebar` → `NAV_ITEMS` array

```ts
const NAV_ITEMS = [
  { page: 'chart',    label: 'Charts',    icon: <IconBarChart2 /> },
  // ... existing items ...
  { page: 'yourpage', label: 'Your Page', icon: <YourIcon /> },  // ← add this
];
```

---

### Step 3 — Add the navbar label
**File:** `src/App.tsx` → inside `AppNavbar` → `PAGE_LABELS` object

```ts
const PAGE_LABELS: Record<string, string> = {
  chart: 'Charts', straddle: 'Straddle', oiprofile: 'OI Profile',
  nubra: 'Nubra IV', backtest: 'Backtest', historical: 'Historical',
  yourpage: 'Your Page',  // ← add this
};
```

> Skip this if your page has its own top bar button (like MTM Analyzer).

---

### Step 4 — Add the keep-alive page container
**File:** `src/App.tsx` → inside `App()` return → `<main>` block

```tsx
{(page === 'yourpage' || visited.has('yourpage')) && (
  <div
    className="absolute inset-0"
    style={{
      visibility: page === 'yourpage' ? 'visible' : 'hidden',
      pointerEvents: page === 'yourpage' ? 'auto' : 'none',
      zIndex: page === 'yourpage' ? 1 : 0,
    }}
  >
    <YourComponent />
  </div>
)}
```

> **Why `visibility:hidden` and not `display:none`?**
> Ant Design and glide-data-grid need to measure the DOM even when hidden.
> `display:none` removes the element from layout → infinite setState loops.
> `visibility:hidden` keeps the element in layout but invisible → safe.

---

### Step 5 — Decide where the state lives

```
Does your component need state shared with other pages?
        │
       YES ──→ Add to AppContext (src/AppContext.tsx)
        │       1. Add state with useState / useRef inside AppProvider
        │       2. Expose it in the value object
        │       3. Add the type to AppContextValue interface
        │
        NO ──→ Keep state local inside YourComponent
                useState / useRef / useCallback — all inside the component
```

---

## State Ownership Rules

| State type | Where it lives |
|---|---|
| Auth — Upstox, Nubra, Dhan, Cookie | `AppSidebar` (never in App) |
| Navigation — page, visited | `AppContext` |
| Shared data — instruments, basket, nubraInstruments | `AppContext` |
| Page-local UI state | Inside the component itself |
| Workspace / chart-search / MTM workers | `App()` local state |

---

## Golden Rules

✅ Auth state always lives in `AppSidebar` — never add it to `App()`

✅ State used by 2+ components → `AppContext`

✅ State used by 1 component only → local `useState` inside that component

✅ Always use `visibility:hidden` pattern for keep-alive pages

❌ Don't add state to `App()` unless it's basket / workspace / chart-search / MTM workers

❌ Don't use `display:none` for pages that use Ant Design or glide-data-grid

❌ Don't add inline arrow functions as props to memoized components — use `useCallback`

---

## Quick Reference — File Locations

| What | File | Where exactly |
|---|---|---|
| Page type | `src/AppContext.tsx` | Line ~10, `Page` type |
| Shared state | `src/AppContext.tsx` | Inside `AppProvider`, exposed in `value` |
| Sidebar nav items | `src/App.tsx` | `AppSidebar` → `NAV_ITEMS` |
| Navbar label | `src/App.tsx` | `AppNavbar` → `PAGE_LABELS` |
| Page container | `src/App.tsx` | `App()` return → `<main>` block |

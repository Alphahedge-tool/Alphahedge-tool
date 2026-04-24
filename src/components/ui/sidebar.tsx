'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import s from './sidebar.module.css';
import { TooltipWrap } from './tooltip';

// ── Constants ─────────────────────────────────────────────────────────────────
const SIDEBAR_WIDTH = 240; // px expanded
const SIDEBAR_ICON_WIDTH = 44; // px collapsed icon rail
const COOKIE_NAME = 'sidebar:state';

// ── Context ───────────────────────────────────────────────────────────────────
type SidebarCtx = {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggleSidebar: () => void;
};
const Ctx = React.createContext<SidebarCtx | null>(null);

export function useSidebar() {
  const ctx = React.useContext(Ctx);
  if (!ctx) throw new Error('useSidebar must be inside SidebarProvider');
  return ctx;
}

// ── Provider ──────────────────────────────────────────────────────────────────
export const SidebarProvider = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { defaultOpen?: boolean }
>(({ defaultOpen = true, className, children, style, ...props }, ref) => {
  const [open, setOpenState] = React.useState(defaultOpen);
  const divRef = React.useRef<HTMLDivElement>(null);

  // Merge forwarded ref + local ref
  const setRef = React.useCallback((node: HTMLDivElement | null) => {
    (divRef as { current: HTMLDivElement | null }).current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) (ref as { current: HTMLDivElement | null }).current = node;
  }, [ref]);

  const setOpen = React.useCallback((v: boolean) => {
    setOpenState(v);
    // Update CSS vars directly on DOM — zero React re-renders during animation
    const el = divRef.current;
    if (el) {
      el.style.setProperty('--sidebar-w', v ? `${SIDEBAR_WIDTH}px` : `${SIDEBAR_ICON_WIDTH}px`);
      el.style.setProperty('--sidebar-text-opacity', v ? '1' : '0');
      el.style.setProperty('--sidebar-logo-size', v ? '28px' : '32px');
    }
    document.cookie = `${COOKIE_NAME}=${v}; path=/; max-age=${60 * 60 * 24 * 7}`;
  }, []);

  const openRef = React.useRef(open);
  openRef.current = open;
  const toggleSidebar = React.useCallback(() => setOpen(!openRef.current), [setOpen]);

  const sidebarW = open ? SIDEBAR_WIDTH : SIDEBAR_ICON_WIDTH;

  return (
    <Ctx.Provider value={{ open, setOpen, toggleSidebar }}>
      <div
        ref={setRef}
        className={cn(s.provider, className)}
        style={{
          ...style,
          '--sidebar-w': `${sidebarW}px`,
          '--sidebar-text-opacity': open ? '1' : '0',
          '--sidebar-logo-size': open ? '28px' : '32px',
        } as React.CSSProperties}
        {...props}
      >
        {children}
      </div>
    </Ctx.Provider>
  );
});
SidebarProvider.displayName = 'SidebarProvider';

// ── Sidebar ───────────────────────────────────────────────────────────────────
export const Sidebar = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & { collapsible?: 'icon' | 'offcanvas' | 'none' }
>(({ collapsible = 'icon', className, children, ...props }, ref) => {
  const { open } = useSidebar();

  return (
    <div
      ref={ref}
      data-state={open ? 'expanded' : 'collapsed'}
      data-collapsible={!open ? collapsible : ''}
      className={cn(s.sidebar, open ? s.sidebarVisible : s.sidebarCollapsed, className)}
      {...props}
    >
      {children}
    </div>
  );
});
Sidebar.displayName = 'Sidebar';

// ── Trigger ───────────────────────────────────────────────────────────────────
export const SidebarTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, onClick, ...props }, ref) => {
  const { toggleSidebar } = useSidebar();
  return (
    <button
      ref={ref}
      onClick={e => { onClick?.(e); toggleSidebar(); }}
      className={cn(s.trigger, className)}
      {...props}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>
      </svg>
      <span className={s.srOnly}>Toggle Sidebar</span>
    </button>
  );
});
SidebarTrigger.displayName = 'SidebarTrigger';

// ── Rail (hover handle) ───────────────────────────────────────────────────────
export const SidebarRail = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, ...props }, ref) => {
  const { toggleSidebar } = useSidebar();
  return (
    <button
      ref={ref}
      onClick={toggleSidebar}
      tabIndex={-1}
      className={cn(s.rail, className)}
      {...props}
    />
  );
});
SidebarRail.displayName = 'SidebarRail';

// ── Layout pieces ─────────────────────────────────────────────────────────────
export const SidebarInset = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn(s.inset, className)} {...props} />
  ),
);
SidebarInset.displayName = 'SidebarInset';

export const SidebarHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn(s.header, className)} {...props} />
  ),
);
SidebarHeader.displayName = 'SidebarHeader';

export const SidebarContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn(s.content, className)} {...props} />
  ),
);
SidebarContent.displayName = 'SidebarContent';

export const SidebarFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn(s.footer, className)} {...props} />
  ),
);
SidebarFooter.displayName = 'SidebarFooter';

// These components read open state from CSS via ancestor [data-state] —
// no useSidebar() subscription needed, so they never re-render on toggle.
export const SidebarGroup = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn(s.group, className)} {...props} />
  ),
);
SidebarGroup.displayName = 'SidebarGroup';

export const SidebarGroupLabel = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn(s.groupLabel, className)} {...props} />
  ),
);
SidebarGroupLabel.displayName = 'SidebarGroupLabel';

export const SidebarGroupContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn(s.groupContent, className)} {...props} />
  ),
);
SidebarGroupContent.displayName = 'SidebarGroupContent';

export const SidebarMenu = React.forwardRef<HTMLUListElement, React.HTMLAttributes<HTMLUListElement>>(
  ({ className, ...props }, ref) => (
    <ul ref={ref} className={cn(s.menu, className)} {...props} />
  ),
);
SidebarMenu.displayName = 'SidebarMenu';

export const SidebarMenuItem = React.forwardRef<HTMLLIElement, React.HTMLAttributes<HTMLLIElement>>(
  ({ className, ...props }, ref) => (
    <li ref={ref} className={cn(s.menuItem, className)} {...props} />
  ),
);
SidebarMenuItem.displayName = 'SidebarMenuItem';

// ── MenuButton ────────────────────────────────────────────────────────────────
export const SidebarMenuButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    isActive?: boolean;
    tooltip?: string;
  }
>(({ isActive, tooltip, className, children, ...props }, ref) => {
  const { open } = useSidebar();

  return (
    <TooltipWrap
      content={tooltip}
      side="right"
      align="center"
      sideOffset={14}
      avoidCollisions={false}
      disabled={open || !tooltip}
    >
      <div className={s.tooltipWrap}>
        <button
          ref={ref}
          data-active={isActive}
          className={cn(s.menuBtn, className)}
          aria-label={tooltip}
          {...props}
        >
          {children}
        </button>
      </div>
    </TooltipWrap>
  );
});
SidebarMenuButton.displayName = 'SidebarMenuButton';

// Re-export unused but imported names so App.tsx doesn't break
export const SidebarSeparator = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn(s.separator, className)} {...props} />
);

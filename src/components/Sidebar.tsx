'use client';

// Tremor Sidebar — URJAA trading terminal
// Colour scheme: bg-white dark:bg-[#030712] (Tremor convention)

import * as React from 'react';
import { cx, focusRing } from '../lib/utils';
import { useIsMobile } from '../lib/useMobile';
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from './Drawer';

const SIDEBAR_COOKIE_NAME = 'sidebar:state';
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_WIDTH = '220px';

// ── Context ───────────────────────────────────────────────────────────────────
type SidebarContextType = {
  state: 'expanded' | 'collapsed';
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextType | null>(null);

export function useSidebar() {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error('useSidebar must be used within SidebarProvider');
  return ctx;
}

// ── Provider ──────────────────────────────────────────────────────────────────
export const SidebarProvider = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<'div'> & {
    defaultOpen?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }
>(({ defaultOpen = true, open: openProp, onOpenChange: setOpenProp, className, style, children, ...props }, ref) => {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);
  const [_open, _setOpen] = React.useState(defaultOpen);

  const open = openProp ?? _open;
  const setOpen = React.useCallback(
    (value: boolean | ((v: boolean) => boolean)) => {
      const next = typeof value === 'function' ? value(open) : value;
      if (setOpenProp) setOpenProp(next); else _setOpen(next);
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${next}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
    },
    [setOpenProp, open],
  );

  const toggleSidebar = React.useCallback(
    () => isMobile ? setOpenMobile(v => !v) : setOpen(v => !v),
    [isMobile, setOpen],
  );

  const state = open ? 'expanded' : 'collapsed';
  const ctx = React.useMemo<SidebarContextType>(
    () => ({ state, open, setOpen, isMobile, openMobile, setOpenMobile, toggleSidebar }),
    [state, open, setOpen, isMobile, openMobile, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={ctx}>
      <div
        ref={ref}
        style={{ '--sidebar-width': SIDEBAR_WIDTH, ...style } as React.CSSProperties}
        className={cx('flex min-h-svh w-full bg-[#171717] text-[#D1D4DC]', className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
});
SidebarProvider.displayName = 'SidebarProvider';

// ── Sidebar shell ─────────────────────────────────────────────────────────────
export const Sidebar = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, children, ...props }, ref) => {
    const { isMobile, state, openMobile, setOpenMobile } = useSidebar();

    if (isMobile) {
      return (
        <Drawer open={openMobile} onOpenChange={setOpenMobile}>
          <DrawerContent style={{ '--sidebar-width': SIDEBAR_WIDTH } as React.CSSProperties}>
            <span className="sr-only">
              <DrawerTitle>Navigation</DrawerTitle>
            </span>
            <div className="relative flex h-full w-full flex-col">
              <DrawerClose className="absolute right-3 top-3 p-1 text-[#787B86] hover:text-[#D1D4DC] transition-colors" asChild>
                <button aria-label="Close sidebar">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M18 6 6 18M6 6l12 12"/>
                  </svg>
                </button>
              </DrawerClose>
              {children}
            </div>
          </DrawerContent>
        </Drawer>
      );
    }

    const collapsed = state === 'collapsed';

    return (
      <>
        {/* Fixed panel — slides in/out via transform */}
        <div
          ref={ref}
          data-state={state}
          className={cx('fixed inset-y-0 left-0 z-40 h-full w-[220px] hidden md:flex', className)}
          style={{
            transform: collapsed ? 'translateX(-220px)' : 'translateX(0)',
            transition: 'transform 300ms cubic-bezier(0.22, 1, 0.36, 1)',
            willChange: 'transform',
          }}
          {...props}
        >
          <div className="glass-sidebar flex h-full w-full flex-col">
            {children}
          </div>
        </div>
      </>
    );
  },
);
Sidebar.displayName = 'Sidebar';

// ── Trigger (hamburger toggle) ────────────────────────────────────────────────
export const SidebarTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithRef<'button'>
>(({ className, onClick, ...props }, ref) => {
  const { toggleSidebar } = useSidebar();
  return (
    <button
      ref={ref}
      className={cx(
        'inline-flex items-center justify-center p-1.5 rounded transition-colors',
        'text-[#787B86] hover:text-[#D1D4DC] hover:bg-[#2A2E39]',
        focusRing,
        className,
      )}
      onClick={e => { onClick?.(e); toggleSidebar(); }}
      {...props}
    >
      {/* PanelLeft icon */}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>
      </svg>
      <span className="sr-only">Toggle Sidebar</span>
    </button>
  );
});
SidebarTrigger.displayName = 'SidebarTrigger';

// ── Header / Content / Footer ─────────────────────────────────────────────────
export const SidebarHeader = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cx('flex flex-col gap-2 p-3', className)} {...props} />
  ),
);
SidebarHeader.displayName = 'SidebarHeader';

export const SidebarContent = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cx('flex min-h-0 flex-1 flex-col gap-1 overflow-auto', className)} {...props} />
  ),
);
SidebarContent.displayName = 'SidebarContent';

export const SidebarFooter = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cx('flex flex-col gap-2 p-3 border-t border-[#2A2E39]', className)} {...props} />
  ),
);
SidebarFooter.displayName = 'SidebarFooter';

// ── Group ─────────────────────────────────────────────────────────────────────
export const SidebarGroup = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cx('flex w-full min-w-0 flex-col px-3 py-2', className)} {...props} />
  ),
);
SidebarGroup.displayName = 'SidebarGroup';

export const SidebarGroupLabel = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cx('mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#9B9EA8]', className)}
      {...props}
    />
  ),
);
SidebarGroupLabel.displayName = 'SidebarGroupLabel';

export const SidebarGroupContent = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cx('w-full', className)} {...props} />
  ),
);
SidebarGroupContent.displayName = 'SidebarGroupContent';

// ── Menu ─────────────────────────────────────────────────────────────────────
export const SidebarMenu = React.forwardRef<HTMLUListElement, React.ComponentProps<'ul'>>(
  ({ className, ...props }, ref) => (
    <ul ref={ref} className={cx('flex w-full min-w-0 flex-col gap-1', className)} {...props} />
  ),
);
SidebarMenu.displayName = 'SidebarMenu';

export const SidebarMenuItem = React.forwardRef<HTMLLIElement, React.ComponentProps<'li'>>(
  (props, ref) => <li ref={ref} {...props} />,
);
SidebarMenuItem.displayName = 'SidebarMenuItem';

// ── Link (nav item) ───────────────────────────────────────────────────────────
export const SidebarLink = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithRef<'button'> & {
    icon?: React.ReactNode;
    isActive?: boolean;
    badge?: string | number;
  }
>(({ children, isActive, icon, badge, className, ...props }, ref) => (
  <button
    ref={ref}
    data-active={isActive}
    className={cx(
      'flex w-full items-center justify-between rounded px-2 py-2.5 text-[13.5px] font-[500] transition-colors duration-100 cursor-pointer',
      'text-[#C0C3CC] hover:bg-[#2A2E39] hover:text-[#E0E3EA]',
      'data-[active=true]:bg-[#2b2b2b] data-[active=true]:text-[#E5E7EB] data-[active=true]:rounded-lg',
      focusRing,
      className,
    )}
    {...props}
  >
    <span className="flex items-center gap-2.5">
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="truncate">{children}</span>
    </span>
    {badge != null && (
      <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-[10px] font-semibold bg-[rgba(255,152,0,0.15)] text-[#FF9800]">
        {badge}
      </span>
    )}
  </button>
));
SidebarLink.displayName = 'SidebarLink';

'use client';

// Tremor Sidebar — URJAA trading terminal
// Colour scheme: bg-white dark:bg-[#030712] (Tremor convention)

import * as React from 'react';
import { cx, focusRing } from '../lib/utils';
import { useIsMobile } from '../lib/useMobile';
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from './Drawer';
import s from './Sidebar.module.css';

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
        className={cx(s.provider, className)}
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
            <span className={s.srOnly}>
              <DrawerTitle>Navigation</DrawerTitle>
            </span>
            <div className={s.mobileInner}>
              <DrawerClose className={s.drawerClose} asChild>
                <button aria-label="Close sidebar">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
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
          className={cx(s.panel, className)}
          style={{
            transform: collapsed ? 'translateX(-220px)' : 'translateX(0)',
            transition: 'transform 300ms cubic-bezier(0.22, 1, 0.36, 1)',
            willChange: 'transform',
          }}
          {...props}
        >
          <div className={cx('glass-sidebar', s.glassInner)}>
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
      className={cx(s.trigger, focusRing, className)}
      onClick={e => { onClick?.(e); toggleSidebar(); }}
      {...props}
    >
      {/* PanelLeft icon */}
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>
      </svg>
      <span className={s.srOnly}>Toggle Sidebar</span>
    </button>
  );
});
SidebarTrigger.displayName = 'SidebarTrigger';

// ── Header / Content / Footer ─────────────────────────────────────────────────
export const SidebarHeader = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cx(s.sidebarHeader, className)} {...props} />
  ),
);
SidebarHeader.displayName = 'SidebarHeader';

export const SidebarContent = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cx(s.sidebarContent, className)} {...props} />
  ),
);
SidebarContent.displayName = 'SidebarContent';

export const SidebarFooter = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cx(s.sidebarFooter, className)} {...props} />
  ),
);
SidebarFooter.displayName = 'SidebarFooter';

// ── Group ─────────────────────────────────────────────────────────────────────
export const SidebarGroup = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cx(s.sidebarGroup, className)} {...props} />
  ),
);
SidebarGroup.displayName = 'SidebarGroup';

export const SidebarGroupLabel = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cx(s.sidebarGroupLabel, className)}
      {...props}
    />
  ),
);
SidebarGroupLabel.displayName = 'SidebarGroupLabel';

export const SidebarGroupContent = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cx(s.sidebarGroupContent, className)} {...props} />
  ),
);
SidebarGroupContent.displayName = 'SidebarGroupContent';

// ── Menu ─────────────────────────────────────────────────────────────────────
export const SidebarMenu = React.forwardRef<HTMLUListElement, React.ComponentProps<'ul'>>(
  ({ className, ...props }, ref) => (
    <ul ref={ref} className={cx(s.sidebarMenu, className)} {...props} />
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
    className={cx(s.sidebarLink, focusRing, className)}
    {...props}
  >
    <span className={s.linkIconWrap}>
      {icon && <span className={s.linkIcon}>{icon}</span>}
      <span className={s.linkText}>{children}</span>
    </span>
    {badge != null && (
      <span className={s.badge}>{badge}</span>
    )}
  </button>
));
SidebarLink.displayName = 'SidebarLink';

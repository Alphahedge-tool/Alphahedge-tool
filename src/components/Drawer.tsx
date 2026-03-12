'use client';

// Drawer — built on shadcn/ui Dialog, URJAA dark theme

import * as React from 'react';
import {
  Dialog,
  DialogPortal,
  DialogClose,
  DialogTitle,
} from './ui/dialog';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cx, focusRing } from '../lib/utils';

const Drawer = (props: React.ComponentPropsWithoutRef<typeof Dialog>) => (
  <Dialog {...props} />
);
Drawer.displayName = 'Drawer';

const DrawerTrigger = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Trigger ref={ref} className={cx(className)} {...props} />
));
DrawerTrigger.displayName = 'DrawerTrigger';

const DrawerClose = React.forwardRef<
  React.ElementRef<typeof DialogClose>,
  React.ComponentPropsWithoutRef<typeof DialogClose>
>(({ className, children, ...props }, ref) => (
  <DialogClose ref={ref} className={cx(className)} {...props}>
    {children}
  </DialogClose>
));
DrawerClose.displayName = 'DrawerClose';

const DrawerPortal = DialogPortal;
DrawerPortal.displayName = 'DrawerPortal';

const DrawerOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, forwardedRef) => (
  <DialogPrimitive.Overlay
    ref={forwardedRef}
    className={cx(
      'fixed inset-0 z-50 overflow-y-auto bg-black/60',
      'data-[state=closed]:animate-hide data-[state=open]:animate-dialogOverlayShow',
      className,
    )}
    style={{ animationDuration: '300ms', animationFillMode: 'backwards' }}
    {...props}
  />
));
DrawerOverlay.displayName = 'DrawerOverlay';

const DrawerContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, ...props }, forwardedRef) => (
  <DrawerPortal>
    <DrawerOverlay>
      <DialogPrimitive.Content
        ref={forwardedRef}
        className={cx(
          'fixed inset-y-0 left-0 z-50 flex w-[--sidebar-width] flex-col shadow-xl',
          'border-r border-[#2a2a2a] bg-[#1f1f1f]',
          'data-[state=closed]:animate-slideRightAndFade data-[state=open]:animate-slideLeftAndFade',
          focusRing,
          className,
        )}
        {...props}
      />
    </DrawerOverlay>
  </DrawerPortal>
));
DrawerContent.displayName = 'DrawerContent';

const DrawerTitle = DialogTitle;
DrawerTitle.displayName = 'DrawerTitle';

export { Drawer, DrawerClose, DrawerContent, DrawerPortal, DrawerTitle, DrawerTrigger };

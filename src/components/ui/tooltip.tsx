'use client';

import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 overflow-hidden rounded-lg border border-black/15 bg-[#F4F6FA] px-3 py-1.5 text-[11px] font-semibold tracking-[0.04em] text-[#0B0F19] shadow-[0_10px_24px_rgba(0,0,0,0.35)] animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-tooltip-content-transform-origin]",
        className
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

function renderTooltipBody(content: React.ReactNode, shortcut?: React.ReactNode) {
  if (content == null && shortcut == null) return null
  if (content == null) {
    return <span className="inline-flex items-center gap-2">{shortcut}</span>
  }

  const contentNode =
    typeof content === "string" ? <span className="leading-relaxed">{content}</span> : content

  if (!shortcut) return contentNode

  return (
    <span className="inline-flex items-center gap-2">
      <span className="leading-relaxed">{contentNode}</span>
      <span className="rounded-md border border-black/10 bg-black/5 px-1.5 py-0.5 font-mono text-[10px] font-bold tracking-[0.08em] text-[#334155]">
        {shortcut}
      </span>
    </span>
  )
}

type TooltipWrapProps = {
  content?: React.ReactNode
  children: React.ReactNode
  side?: React.ComponentProps<typeof TooltipPrimitive.Content>["side"]
  align?: React.ComponentProps<typeof TooltipPrimitive.Content>["align"]
  sideOffset?: number
  alignOffset?: number
  delayDuration?: number
  disabled?: boolean
  avoidCollisions?: boolean
  collisionPadding?: number | Partial<Record<"top" | "right" | "bottom" | "left", number>>
  disableHoverableContent?: boolean
  shortcut?: React.ReactNode
  contentClassName?: string
  arrow?: boolean
}

function TooltipWrap({
  content,
  children,
  side = "top",
  align = "center",
  sideOffset = 8,
  alignOffset = 0,
  delayDuration = 120,
  disabled = false,
  avoidCollisions = true,
  collisionPadding = 8,
  disableHoverableContent = false,
  shortcut,
  contentClassName,
  arrow = false,
}: TooltipWrapProps) {
  if ((!content && !shortcut) || disabled) return <>{children}</>

  const tooltipBody = renderTooltipBody(content, shortcut)

  return (
    <TooltipProvider delayDuration={delayDuration} disableHoverableContent={disableHoverableContent}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side={side}
          align={align}
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          avoidCollisions={avoidCollisions}
          collisionPadding={collisionPadding}
          className={cn("max-w-[280px] whitespace-pre-wrap leading-relaxed", contentClassName)}
        >
          {tooltipBody}
          {arrow ? (
            <TooltipPrimitive.Arrow className="fill-[#F4F6FA] drop-shadow-[0_2px_6px_rgba(0,0,0,0.18)]" />
          ) : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, TooltipWrap }

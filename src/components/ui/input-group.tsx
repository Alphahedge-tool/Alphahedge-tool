'use client';

import * as React from "react"
import { cn } from "@/lib/utils"

const InputGroup = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex items-stretch", className)}
    {...props}
  />
))
InputGroup.displayName = "InputGroup"

const InputGroupAddon = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex items-center px-2 text-[12px] text-[#787B86] bg-[#2a2a2a] border border-[#2a2a2a] select-none shrink-0",
      "first:rounded-l last:rounded-r border-r-0 last:border-r",
      className,
    )}
    {...props}
  />
))
InputGroupAddon.displayName = "InputGroupAddon"

const InputGroupText = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement>
>(({ className, ...props }, ref) => (
  <span
    ref={ref}
    className={cn("text-[12px] text-[#787B86]", className)}
    {...props}
  />
))
InputGroupText.displayName = "InputGroupText"

const InputGroupInput = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "flex-1 min-w-0 h-7 px-2.5 text-[13px] text-[#D1D4DC] bg-[#1f1f1f] border border-[#2a2a2a]",
      "outline-none transition-colors duration-100",
      "placeholder:text-[#4A4E5C]",
      "focus:border-[rgba(255,152,0,0.45)] focus:z-10",
      "disabled:opacity-40 disabled:cursor-not-allowed",
      "first:rounded-l last:rounded-r",
      "[&:not(:first-child)]:border-l-0 [&:not(:last-child)]:border-r-0",
      className,
    )}
    {...props}
  />
))
InputGroupInput.displayName = "InputGroupInput"

const InputGroupTextarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "flex-1 min-w-0 px-2.5 py-1.5 text-[13px] text-[#D1D4DC] bg-[#1f1f1f] border border-[#2a2a2a]",
      "outline-none transition-colors duration-100 resize-y",
      "placeholder:text-[#4A4E5C]",
      "focus:border-[rgba(255,152,0,0.45)]",
      "first:rounded-l last:rounded-r",
      "[&:not(:first-child)]:border-l-0 [&:not(:last-child)]:border-r-0",
      className,
    )}
    {...props}
  />
))
InputGroupTextarea.displayName = "InputGroupTextarea"

const InputGroupButton = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ className, ...props }, ref) => (
  <button
    ref={ref}
    className={cn(
      "flex items-center justify-center px-2.5 h-7 text-[12px] font-medium shrink-0",
      "bg-[#2a2a2a] border border-[#2a2a2a] text-[#D1D4DC]",
      "transition-colors duration-100 cursor-pointer",
      "hover:bg-[#333333] hover:text-[#fff]",
      "disabled:opacity-40 disabled:cursor-not-allowed",
      "first:rounded-l last:rounded-r",
      "[&:not(:first-child)]:border-l-0 [&:not(:last-child)]:border-r-0",
      className,
    )}
    {...props}
  />
))
InputGroupButton.displayName = "InputGroupButton"

export {
  InputGroup,
  InputGroupAddon,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
  InputGroupButton,
}

'use client';

import * as React from "react"
import { cn } from "@/lib/utils"

interface NativeSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
}

const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, label, id, children, multiple, style, ...props }, ref) => {
    const selectEl = (
      <select
        ref={ref}
        id={id}
        multiple={multiple}
        className={cn(
          "w-full px-2 text-[13px] text-[#D1D4DC] bg-[#1f1f1f] border border-[#2a2a2a] rounded",
          "outline-none cursor-pointer transition-colors duration-100",
          !multiple && "h-7 pr-6 appearance-none leading-[1.15] py-0",
          multiple && "py-1 min-h-[60px]",
          "hover:border-[#333333] focus:border-[rgba(255,152,0,0.45)]",
          "disabled:opacity-40 disabled:cursor-not-allowed",
          "[color-scheme:dark]",
          className,
        )}
        style={multiple ? style : {
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23787B86' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")`,
          backgroundRepeat: "no-repeat",
          backgroundPosition: "right 6px center",
          ...style,
        }}
        {...props}
      >
        {children}
      </select>
    )

    if (!label) return selectEl

    return (
      <div className="flex flex-col gap-0.5 shrink-0">
        <label
          htmlFor={id}
          className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[#787B86] select-none"
        >
          {label}
        </label>
        {selectEl}
      </div>
    )
  },
)
NativeSelect.displayName = "NativeSelect"

const NativeSelectOptGroup = React.forwardRef<
  HTMLOptGroupElement,
  React.OptgroupHTMLAttributes<HTMLOptGroupElement>
>(({ className, ...props }, ref) => (
  <optgroup
    ref={ref}
    className={cn("text-[11px] font-semibold text-[#787B86]", className)}
    style={{ background: "#171717" }}
    {...props}
  />
))
NativeSelectOptGroup.displayName = "NativeSelectOptGroup"

const NativeSelectOption = React.forwardRef<
  HTMLOptionElement,
  React.OptionHTMLAttributes<HTMLOptionElement>
>(({ className, ...props }, ref) => (
  <option
    ref={ref}
    className={cn("text-[13px] text-[#D1D4DC]", className)}
    style={{ background: "#1f1f1f" }}
    {...props}
  />
))
NativeSelectOption.displayName = "NativeSelectOption"

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption }

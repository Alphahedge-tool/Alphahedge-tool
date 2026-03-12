/**
 * UI kit — shadcn/ui components + plain HTML inputs.
 * TradingView palette: #171717 / #1f1f1f / #2a2a2a
 */

import * as React from 'react';
import {
  Select as ShadSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import {
  Tabs as ShadTabs,
  TabsList as ShadTabsList,
  TabsTrigger as ShadTabsTrigger,
  TabsContent as ShadTabsContent,
} from './ui/tabs';
import { cx } from '../lib/utils';

// ── Button ────────────────────────────────────────────────────────────────────

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger' | 'active';
  size?: 'sm' | 'xs';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'ghost', size = 'sm', className, children, ...props }, ref) => (
    <button
      ref={ref}
      className={cx(
        'inline-flex items-center justify-center gap-1 font-medium rounded transition-colors duration-100 cursor-pointer select-none disabled:opacity-40 disabled:pointer-events-none border',
        size === 'sm' ? 'px-2.5 py-1 text-[12px] h-7' : 'px-1.5 py-0.5 text-[10px] h-[22px]',
        variant === 'primary' && 'bg-[rgba(255,152,0,0.15)] text-[#FF9800] border-[rgba(255,152,0,0.35)] hover:bg-[rgba(255,152,0,0.25)]',
        variant === 'ghost'   && 'bg-[rgba(255,255,255,0.04)] text-[#787B86] border-[rgba(255,255,255,0.07)] hover:bg-[rgba(255,255,255,0.09)] hover:text-[#D1D4DC]',
        variant === 'danger'  && 'bg-[rgba(242,54,69,0.15)] text-[#f23645] border-[rgba(242,54,69,0.30)] hover:bg-[rgba(242,54,69,0.25)]',
        variant === 'active'  && 'bg-[rgba(255,152,0,0.15)] text-[#FF9800] border-[rgba(255,152,0,0.35)]',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

// ── Select (shadcn/ui) ──────────────────────────────────────────────────────────

interface SelectProps {
  value: string;
  onValueChange: (v: string) => void;
  options: { label: string; value: string | number }[];
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}

export function Select({ value, onValueChange, options, className, placeholder, disabled }: SelectProps) {
  return (
    <ShadSelect value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger
        className={cx(
          'h-7 px-2 rounded text-[12px] text-[#D1D4DC] bg-[#1f1f1f] border border-[#2a2a2a] outline-none cursor-pointer transition-colors hover:border-[#333333] disabled:opacity-40 min-w-[80px] focus:ring-0 focus:ring-offset-0',
          className,
        )}
      >
        <SelectValue placeholder={placeholder ?? '—'} />
      </SelectTrigger>
      <SelectContent className="z-[9999] bg-[#1f1f1f] border border-[#2a2a2a] text-[12px] text-[#D1D4DC] shadow-[0_8px_32px_rgba(0,0,0,0.65)]">
        {options.map(o => (
          <SelectItem
            key={o.value}
            value={String(o.value)}
            className="cursor-pointer text-[12px] hover:bg-[rgba(255,152,0,0.08)] focus:bg-[rgba(255,152,0,0.08)] data-[state=checked]:text-[#FF9800]"
          >
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </ShadSelect>
  );
}

// ── NativeSelect (lightweight fallback) ──────────────────────────────────────

interface NativeSelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: { label: string; value: string | number }[];
  placeholder?: string;
}

export const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ options, placeholder, className, ...props }, ref) => (
    <select
      ref={ref}
      className={cx(
        'h-7 rounded px-2 text-[12px] text-[#D1D4DC] bg-[#1f1f1f] border border-[#2a2a2a] outline-none cursor-pointer transition-colors hover:border-[#333333] focus:border-[rgba(255,152,0,0.45)] appearance-none disabled:opacity-40',
        className,
      )}
      {...props}
    >
      {placeholder && (
        <option value="" disabled style={{ background: '#171717' }}>{placeholder}</option>
      )}
      {options.map(o => (
        <option key={o.value} value={o.value} style={{ background: '#171717' }}>
          {o.label}
        </option>
      ))}
    </select>
  ),
);
NativeSelect.displayName = 'NativeSelect';

// ── DateInput ─────────────────────────────────────────────────────────────────

interface DateInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
}

export const DateInput = React.forwardRef<HTMLInputElement, DateInputProps>(
  ({ label, className, ...props }, ref) => {
    const input = (
      <input
        ref={ref}
        type="date"
        className={cx(
          'h-7 rounded px-2 text-[12px] text-[#D1D4DC] bg-[#1f1f1f] border border-[#2a2a2a] outline-none cursor-pointer transition-colors hover:border-[#333333] focus:border-[rgba(255,152,0,0.45)] disabled:opacity-40 [color-scheme:dark]',
          className,
        )}
        {...props}
      />
    );
    if (!label) return input;
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-[10px] text-[#52525b] uppercase tracking-[0.08em]">{label}</span>
        {input}
      </div>
    );
  },
);
DateInput.displayName = 'DateInput';

// ── TextInput ─────────────────────────────────────────────────────────────────

export const TextInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cx(
        'h-7 rounded px-2 text-[12px] text-[#D1D4DC] bg-[#1f1f1f] border border-[#2a2a2a] outline-none transition-colors hover:border-[#333333] focus:border-[rgba(255,152,0,0.45)] placeholder:text-[#52525b] disabled:opacity-40',
        className,
      )}
      {...props}
    />
  ),
);
TextInput.displayName = 'TextInput';

// ── NumberInput ───────────────────────────────────────────────────────────────

interface NumberInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  onValueChange?: (v: number) => void;
}

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ onValueChange, className, ...props }, ref) => (
    <input
      ref={ref}
      type="number"
      onChange={e => onValueChange?.(Number(e.target.value))}
      className={cx(
        'h-7 rounded px-2 text-[12px] text-[#D1D4DC] bg-[#1f1f1f] border border-[#2a2a2a] outline-none transition-colors hover:border-[#333333] focus:border-[rgba(255,152,0,0.45)] disabled:opacity-40',
        '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none',
        className,
      )}
      {...props}
    />
  ),
);
NumberInput.displayName = 'NumberInput';

// ── TextArea ──────────────────────────────────────────────────────────────────

export const TextArea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cx(
        'rounded px-2 py-1.5 text-[12px] text-[#D1D4DC] bg-[#1f1f1f] border border-[#2a2a2a] outline-none transition-colors hover:border-[#333333] focus:border-[rgba(255,152,0,0.45)] placeholder:text-[#52525b] disabled:opacity-40 resize-y font-mono leading-relaxed',
        className,
      )}
      {...props}
    />
  ),
);
TextArea.displayName = 'TextArea';

// ── SearchInput ───────────────────────────────────────────────────────────────

interface SearchInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  onClear?: () => void;
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  ({ onClear, value, className, ...props }, ref) => (
    <div className="relative flex items-center">
      <svg
        className="absolute left-2.5 w-3 h-3 text-[#52525b] pointer-events-none"
        fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"
      >
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
      </svg>
      <input
        ref={ref}
        value={value}
        className={cx(
          'h-7 w-full rounded pl-7 pr-6 text-[12px] text-[#D1D4DC] bg-[#1f1f1f] border border-[#2a2a2a] outline-none transition-colors hover:border-[#333333] focus:border-[rgba(255,152,0,0.45)] placeholder:text-[#52525b] disabled:opacity-40',
          className,
        )}
        {...props}
      />
      {value && onClear && (
        <button
          type="button"
          onClick={onClear}
          className="absolute right-2 text-[#52525b] hover:text-[#D1D4DC] transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M18 6 6 18M6 6l12 12"/>
          </svg>
        </button>
      )}
    </div>
  ),
);
SearchInput.displayName = 'SearchInput';

// ── Badge ─────────────────────────────────────────────────────────────────────

const BADGE_CLASSES: Record<string, string> = {
  emerald: 'bg-[rgba(52,211,153,0.12)] text-[#34d399] border-[rgba(52,211,153,0.25)]',
  green:   'bg-[rgba(46,189,133,0.12)] text-[#2ebd85] border-[rgba(46,189,133,0.25)]',
  red:     'bg-[rgba(242,54,69,0.12)] text-[#f23645] border-[rgba(242,54,69,0.25)]',
  orange:  'bg-[rgba(255,152,0,0.12)] text-[#FF9800] border-[rgba(255,152,0,0.25)]',
  cyan:    'bg-[rgba(34,211,238,0.12)] text-[#22d3ee] border-[rgba(34,211,238,0.25)]',
  purple:  'bg-[rgba(167,139,250,0.12)] text-[#a78bfa] border-[rgba(167,139,250,0.25)]',
  gray:    'bg-[rgba(120,123,134,0.12)] text-[#787B86] border-[rgba(120,123,134,0.25)]',
};

interface BadgeProps {
  color?: keyof typeof BADGE_CLASSES;
  children: React.ReactNode;
  className?: string;
}

export function Badge({ color = 'gray', children, className }: BadgeProps) {
  return (
    <span className={cx(
      'inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border tracking-[0.04em] whitespace-nowrap',
      BADGE_CLASSES[color] ?? BADGE_CLASSES.gray,
      className,
    )}>
      {children}
    </span>
  );
}

// ── Spinner ───────────────────────────────────────────────────────────────────

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cx('animate-spin', className ?? 'h-4 w-4 text-[#787B86]')}
      fill="none" viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ── ErrorBanner ───────────────────────────────────────────────────────────────

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-[#f23645] bg-[rgba(242,54,69,0.08)] border-b border-[rgba(242,54,69,0.18)] shrink-0">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      {message}
    </div>
  );
}

// ── SuccessBanner ─────────────────────────────────────────────────────────────

export function SuccessBanner({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-[#2ebd85] bg-[rgba(46,189,133,0.08)] border-b border-[rgba(46,189,133,0.18)] shrink-0">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
      </svg>
      {message}
    </div>
  );
}

// ── LiveBadge ─────────────────────────────────────────────────────────────────

export function LiveBadge() {
  return (
    <span className="flex items-center gap-1 text-[10px] text-[#2ebd85]">
      <span className="w-1.5 h-1.5 rounded-full bg-[#2ebd85] animate-pulse" />
      LIVE
    </span>
  );
}

// ── Tabs (shadcn/ui) ──────────────────────────────────────────────────────────

export const Tabs = ShadTabs;

export function TabsList({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <ShadTabsList
      className={cx(
        'flex gap-0.5 p-0.5 h-auto bg-[#1f1f1f] border border-[#2a2a2a] rounded-md',
        className,
      )}
    >
      {children}
    </ShadTabsList>
  );
}

export function TabsTrigger({ value, children, className }: { value: string; children: React.ReactNode; className?: string }) {
  return (
    <ShadTabsTrigger
      value={value}
      className={cx(
        'px-2.5 py-1 rounded text-[11px] font-medium cursor-pointer bg-transparent text-[#787B86] transition-colors',
        'hover:text-[#D1D4DC]',
        'data-[state=active]:bg-[rgba(255,152,0,0.12)] data-[state=active]:text-[#FF9800] data-[state=active]:shadow-none',
        className,
      )}
    >
      {children}
    </ShadTabsTrigger>
  );
}

export const TabsContent = ShadTabsContent;

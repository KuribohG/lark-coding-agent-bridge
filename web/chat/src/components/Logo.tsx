import { cn } from '@shared/cn';

/** The Bridge mark: an arch and its piers. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden>
      <rect width="32" height="32" rx="8.5" fill="var(--primary)" />
      <path d="M7 21.5c0-6.2 4-10.5 9-10.5s9 4.300 9 10.500" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M11.300 21.500v-3.800M16 21.500v-6.800M20.700 21.500v-3.800" stroke="white" strokeOpacity="0.85" strokeWidth="2.1" strokeLinecap="round" />
    </svg>
  );
}

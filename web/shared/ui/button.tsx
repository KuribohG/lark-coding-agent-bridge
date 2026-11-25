import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../cn';

const variants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors select-none disabled:opacity-45 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary-hover shadow-[inset_0_1px_0_oklch(1_0_0/18%)]',
        secondary: 'border border-border-strong bg-card text-foreground hover:bg-muted',
        ghost: 'text-muted-foreground hover:bg-hover hover:text-foreground',
        danger: 'bg-destructive text-white hover:opacity-90',
        soft: 'bg-accent text-accent-foreground hover:brightness-[0.97] dark:hover:brightness-110',
      },
      size: {
        sm: 'h-7 px-2.5 text-[12.5px] [&_svg]:size-3.5',
        md: 'h-8.5 px-3.5 text-[13.5px] [&_svg]:size-4',
        lg: 'h-10 px-4.5 text-sm [&_svg]:size-4',
        icon: 'size-8 [&_svg]:size-4',
        'icon-sm': 'size-7 [&_svg]:size-[15px]',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof variants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, type = 'button', ...props }, ref) => (
  <button ref={ref} type={type} className={cn(variants({ variant, size }), className)} {...props} />
));
Button.displayName = 'Button';

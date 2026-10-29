import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { forwardRef, type ComponentPropsWithoutRef } from "react"

import { cn } from "../../lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-none font-semibold leading-[1.1] tracking-[0.02em] whitespace-nowrap transition-[background-color,border-color,color,transform] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "border border-[var(--brand)] bg-[var(--brand)] text-white hover:border-[var(--brand-strong)] hover:bg-[var(--brand-strong)]",
        secondary:
          "border border-[var(--line-strong)] bg-transparent text-[var(--ink)] hover:border-[var(--ink)] hover:bg-[var(--ink)] hover:text-[var(--paper)]",
      },
      size: {
        sm: "px-2 py-1.5 text-[9px]",
        md: "px-3 py-2 text-[11px]",
        lg: "px-3 py-3 text-[12px]",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
)

interface ButtonProps
  extends ComponentPropsWithoutRef<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  },
)
Button.displayName = "Button"

export { Button, buttonVariants }

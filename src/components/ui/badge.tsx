import { cn } from "@/lib/utils";

export function Badge({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={cn("rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400", className)}>
      {children}
    </span>
  );
}

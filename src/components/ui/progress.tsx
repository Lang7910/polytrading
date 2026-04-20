import { cn } from "@/lib/utils";

export function Progress({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-zinc-800", className)}>
      <div className="h-full bg-emerald-500 transition-all" style={{ width: `${value}%` }} />
    </div>
  );
}

import { ReactNode } from 'react';
import clsx from 'clsx';

interface MetricCardProps {
  title: string;
  value: ReactNode;
  trend?: string;
}

export function MetricCard({ title, value, trend }: MetricCardProps) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 shadow-lg shadow-black/20">
      <p className="text-sm uppercase tracking-wide text-slate-400">{title}</p>
      <div className="mt-2 text-3xl font-semibold text-white">{value}</div>
      {trend && <p className="mt-3 text-xs text-slate-500">{trend}</p>}
    </div>
  );
}

interface CardGridProps {
  children: ReactNode;
  columns?: number;
}

export function CardGrid({ children, columns = 4 }: CardGridProps) {
  return (
    <div
      className={clsx(
        'grid gap-4',
        columns === 4 && 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-4',
        columns === 3 && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
      )}
    >
      {children}
    </div>
  );
}

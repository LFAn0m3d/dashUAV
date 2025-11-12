import { useMemo } from 'react';
import { Separator } from '@radix-ui/react-separator';
import { CardGrid, MetricCard } from '../components/Cards';
import MapWidget from '../components/MapWidget';
import { useEventFeed } from '../lib/hooks';

function Dashboard() {
  const { events, loading, error } = useEventFeed();

  const totals = useMemo(() => {
    const telemetry = events.filter((event) => event.type.startsWith('telemetry'));
    const detections = events.filter((event) => event.type.startsWith('detection'));
    const latest = events.at(-1);

    return {
      events: events.length,
      telemetry: telemetry.length,
      detections: detections.length,
      latestTs: latest?.ts,
    };
  }, [events]);

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="text-xl font-semibold text-white">Mission Overview</h2>
        <p className="mt-1 text-sm text-slate-400">
          Consolidated metrics for the last {events.length} events streamed from the backend.
        </p>
      </section>

      <Separator className="h-px bg-slate-800" />

      <CardGrid>
        <MetricCard title="Total Events" value={loading ? '…' : totals.events} />
        <MetricCard
          title="Telemetry"
          value={loading ? '…' : totals.telemetry}
          trend="Incoming updates from all active vehicles"
        />
        <MetricCard
          title="Detections"
          value={loading ? '…' : totals.detections}
          trend="Automatic alerts from perimeter systems"
        />
        <MetricCard
          title="Last Update"
          value={loading ? '–' : totals.latestTs ? new Date(totals.latestTs).toLocaleTimeString() : 'No data'}
          trend={error ? `Last error: ${error}` : 'Synchronized via polling every 5 seconds'}
        />
      </CardGrid>

      <MapWidget status={loading ? 'Booting sensors' : error ? 'Degraded' : 'Nominal'} />
    </div>
  );
}

export default Dashboard;

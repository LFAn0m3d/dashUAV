import { useEffect, useState } from 'react';
import { getAppConfig } from './config';

export interface EventRecord {
  id: string;
  type: string;
  ts: number;
  payload: Record<string, unknown>;
}

export function useEventFeed(pollInterval = 5000) {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const { HTTP_POLL_URL } = getAppConfig();

    async function fetchEvents() {
      try {
        const response = await fetch(HTTP_POLL_URL);
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }
        const data = (await response.json()) as EventRecord[];
        if (!active) return;
        setEvents(data);
        setError(null);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    fetchEvents();
    const interval = window.setInterval(fetchEvents, pollInterval);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [pollInterval]);

  return { events, loading, error };
}

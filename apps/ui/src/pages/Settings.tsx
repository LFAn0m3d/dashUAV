function Settings() {
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-xl font-semibold text-white">Control Centre Settings</h2>
        <p className="mt-1 text-sm text-slate-400">
          Tune data retention limits, stream preferences, and notification policies for the operations room.
        </p>
      </header>
      <form className="space-y-5 rounded-lg border border-slate-800 bg-slate-900/60 p-6">
        <div className="space-y-2">
          <label htmlFor="events" className="text-sm font-medium text-slate-200">
            Maximum buffered events
          </label>
          <input
            id="events"
            name="events"
            type="number"
            min={100}
            defaultValue={5000}
            className="w-full rounded-md border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:border-primary focus:outline-none"
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="telemetry" className="text-sm font-medium text-slate-200">
            Telemetry retention (minutes)
          </label>
          <input
            id="telemetry"
            name="telemetry"
            type="number"
            min={10}
            defaultValue={120}
            className="w-full rounded-md border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:border-primary focus:outline-none"
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="notifications" className="text-sm font-medium text-slate-200">
            Notification policy
          </label>
          <select
            id="notifications"
            name="notifications"
            className="w-full rounded-md border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:border-primary focus:outline-none"
            defaultValue="critical"
          >
            <option value="critical">Critical only</option>
            <option value="all">All events</option>
            <option value="muted">Muted</option>
          </select>
        </div>
        <button
          type="submit"
          className="inline-flex items-center justify-center rounded-md bg-primary/90 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-primary"
        >
          Save Configuration
        </button>
      </form>
    </div>
  );
}

export default Settings;

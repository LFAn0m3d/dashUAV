function Threats() {
  const mockThreats = [
    { id: 'T-100', level: 'High', description: 'Unknown UAV approaching perimeter', timestamp: '2 minutes ago' },
    { id: 'T-099', level: 'Medium', description: 'Signal interference detected on channel 4', timestamp: '12 minutes ago' },
    { id: 'T-098', level: 'Low', description: 'Weather warning issued for launch area', timestamp: '35 minutes ago' },
  ];

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-xl font-semibold text-white">Threat Intelligence</h2>
        <p className="mt-1 text-sm text-slate-400">
          Prioritised list of alerts aggregated from detection systems across the theatre.
        </p>
      </header>
      <div className="rounded-lg border border-slate-800 bg-slate-900/60">
        <table className="w-full table-auto text-left text-sm">
          <thead className="border-b border-slate-800 text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3">Threat</th>
              <th className="px-4 py-3">Level</th>
              <th className="px-4 py-3">Details</th>
              <th className="px-4 py-3">Last seen</th>
            </tr>
          </thead>
          <tbody>
            {mockThreats.map((threat) => (
              <tr key={threat.id} className="border-b border-slate-800/60 last:border-none">
                <td className="px-4 py-3 font-medium text-slate-200">{threat.id}</td>
                <td className="px-4 py-3">
                  <span
                    className="rounded-full bg-slate-800 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-300"
                  >
                    {threat.level}
                  </span>
                </td>
                <td className="px-4 py-3 text-slate-300">{threat.description}</td>
                <td className="px-4 py-3 text-slate-500">{threat.timestamp}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default Threats;

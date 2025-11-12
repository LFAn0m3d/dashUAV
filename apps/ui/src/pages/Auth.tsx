function Auth() {
  return (
    <div className="mx-auto max-w-md space-y-6">
      <header className="text-center">
        <h2 className="text-xl font-semibold text-white">Secure Access Portal</h2>
        <p className="mt-1 text-sm text-slate-400">
          Multi-factor authentication is required for all mission control operators.
        </p>
      </header>
      <form className="space-y-5 rounded-lg border border-slate-800 bg-slate-900/60 p-6">
        <div className="space-y-2 text-left">
          <label htmlFor="username" className="text-sm font-medium text-slate-200">
            Callsign or email
          </label>
          <input
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            className="w-full rounded-md border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:border-primary focus:outline-none"
          />
        </div>
        <div className="space-y-2 text-left">
          <label htmlFor="password" className="text-sm font-medium text-slate-200">
            Access token
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            className="w-full rounded-md border border-slate-700 bg-slate-950/80 px-3 py-2 text-sm text-slate-100 focus:border-primary focus:outline-none"
          />
        </div>
        <button
          type="submit"
          className="inline-flex w-full items-center justify-center rounded-md bg-primary/90 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-primary"
        >
          Authenticate
        </button>
        <p className="text-center text-xs text-slate-500">
          Access is logged and monitored. Report suspicious activity immediately.
        </p>
      </form>
    </div>
  );
}

export default Auth;

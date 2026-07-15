// Claude Code statistics — Übersicht desktop widget
// Install: copy the enclosing `claude-stats.widget` folder into your Übersicht
// widgets directory (~/Library/Application Support/Übersicht/widgets/), and make
// sure the helper service is running (`claude-stats serve`).
//
// The widget shells out to `curl` so there are no cross-origin / fetch issues.

const PORT = 4318; // must match CLAUDE_STATS_PORT in the helper
const HOST = "127.0.0.1";

export const command = `curl -s --max-time 4 http://${HOST}:${PORT}/stats || echo '__OFFLINE__'`;

export const refreshFrequency = 10000; // 10s

export const className = `
  top: 40px;
  left: 40px;
  width: 320px;
  font-family: -apple-system, "SF Pro Display", "Helvetica Neue", sans-serif;
  color: #ECECEC;
  -webkit-font-smoothing: antialiased;

  .cs-card {
    background: rgba(20, 22, 28, 0.72);
    backdrop-filter: blur(24px) saturate(140%);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 18px;
    padding: 18px 20px 16px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  }
  .cs-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }
  .cs-title { font-size: 14px; font-weight: 600; letter-spacing: 0.2px; }
  .cs-dot {
    width: 8px; height: 8px; border-radius: 50%;
    box-shadow: 0 0 8px currentColor;
  }
  .cs-live { color: #4ADE80; }
  .cs-stale { color: #6B7280; box-shadow: none; }
  .cs-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .cs-tile {
    background: rgba(255, 255, 255, 0.045);
    border-radius: 12px;
    padding: 10px 12px;
  }
  .cs-tile .v {
    font-size: 20px; font-weight: 700; line-height: 1.1;
    font-variant-numeric: tabular-nums;
  }
  .cs-tile .l {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px;
    color: #9AA0AA; margin-top: 3px;
  }
  .cs-cost .v { color: #FBBF24; }
  .cs-streak .v { color: #F97316; }
  .cs-foot {
    display: flex; justify-content: space-between; align-items: center;
    margin-top: 12px; padding-top: 10px;
    border-top: 1px solid rgba(255,255,255,0.07);
    font-size: 11px; color: #9AA0AA;
  }
  .cs-foot .model { color: #C4B5FD; font-weight: 600; }

  .cs-limits { margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.07); }
  .cs-limits-title {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.7px;
    color: #9AA0AA; margin-bottom: 10px;
  }
  .cs-bar-row { margin-bottom: 11px; }
  .cs-bar-row:last-child { margin-bottom: 2px; }
  .cs-bar-head {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-bottom: 5px;
  }
  .cs-bar-label { font-size: 12px; font-weight: 600; color: #E5E7EB; }
  .cs-bar-pct { font-size: 11px; color: #9AA0AA; font-variant-numeric: tabular-nums; }
  .cs-bar-track {
    height: 6px; border-radius: 4px; background: rgba(255,255,255,0.09); overflow: hidden;
  }
  .cs-bar-fill { height: 100%; border-radius: 4px; transition: width 0.4s ease; }
  .cs-time-track {
    height: 3px; border-radius: 3px; background: rgba(255,255,255,0.06);
    overflow: hidden; margin-top: 5px;
  }
  .cs-time-fill { height: 100%; border-radius: 3px; background: #64748B; transition: width 0.4s ease; }
  .cs-bar-reset { font-size: 10px; color: #6B7280; margin-top: 4px; }

  .cs-offline { padding: 6px 2px; font-size: 12px; color: #9AA0AA; line-height: 1.5; }
  .cs-offline code { color: #ECECEC; background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 4px; }
`;

function fmt(n) {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}
function usd(n) {
  if (n == null) return "—";
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function hour(h) {
  if (h == null) return "—";
  const ampm = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${ampm}`;
}
function shortModel(m) {
  if (!m) return "—";
  return m.replace(/^anthropic\./, "").replace(/-\d{8}$/, "");
}
function barColor(pct) {
  if (pct >= 90) return "#EF4444"; // red
  if (pct >= 75) return "#FBBF24"; // amber
  return "#3B82F6"; // blue
}
// Length of each rate-limit window, so the time bar has a denominator.
// five_hour → 5h; every seven_day* window → 7 days.
function windowSeconds(bar) {
  if (bar.id === "five_hour") return 5 * 3600;
  if (bar.id && bar.id.indexOf("seven_day") === 0) return 7 * 86400;
  return null;
}
// Fraction of the window already elapsed (0–100), from resetInSeconds.
function timeElapsedPercent(bar) {
  const total = windowSeconds(bar);
  if (total == null || bar.resetInSeconds == null) return null;
  const remaining = Math.max(0, Math.min(total, bar.resetInSeconds));
  return ((total - remaining) / total) * 100;
}
function resetText(bar) {
  const s = bar.resetInSeconds;
  if (s != null && s < 86400) {
    if (s < 3600) return `Resets in ${Math.max(1, Math.round(s / 60))} min`;
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return `Resets in ${h}h${m ? " " + m + "m" : ""}`;
  }
  if (bar.resetAt) {
    const d = new Date(bar.resetAt);
    if (!isNaN(d.getTime())) {
      const day = d.toLocaleDateString("en-US", { weekday: "short" });
      const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
      return `Resets ${day} ${time}`;
    }
  }
  return "";
}

export const render = ({ output }) => {
  if (!output || output.indexOf("__OFFLINE__") !== -1) {
    return (
      <div className="cs-card">
        <div className="cs-head">
          <span className="cs-title">Claude Code</span>
          <span className="cs-dot cs-stale" />
        </div>
        <div className="cs-offline">
          Helper offline. Start it with:
          <br />
          <code>claude-stats serve</code>
        </div>
      </div>
    );
  }

  let s;
  try {
    s = JSON.parse(output);
  } catch (e) {
    return (
      <div className="cs-card">
        <div className="cs-offline">Could not parse helper response.</div>
      </div>
    );
  }

  const live = s.telemetry && s.telemetry.available;
  const t = s.tokens || {};

  return (
    <div className="cs-card">
      <div className="cs-head">
        <span className="cs-title">Claude Code</span>
        <span
          className={"cs-dot " + (live ? "cs-live" : "cs-stale")}
          title={live ? "Live telemetry" : "Files only"}
        />
      </div>

      <div className="cs-grid">
        <div className="cs-tile">
          <div className="v">{fmt(s.sessions)}</div>
          <div className="l">Sessions</div>
        </div>
        <div className="cs-tile">
          <div className="v">{fmt(s.messages)}</div>
          <div className="l">Messages</div>
        </div>
        <div className="cs-tile">
          <div className="v">{fmt(t.total)}</div>
          <div className="l">Tokens</div>
        </div>
        <div className="cs-tile cs-cost">
          <div className="v">{usd(s.cost)}</div>
          <div className="l">Est. Cost</div>
        </div>
        <div className="cs-tile cs-streak">
          <div className="v">{fmt(s.currentStreak)}🔥</div>
          <div className="l">Day Streak</div>
        </div>
        <div className="cs-tile">
          <div className="v">{hour(s.peakHour)}</div>
          <div className="l">Peak Hour</div>
        </div>
      </div>

      <div className="cs-foot">
        <span>{fmt(s.activeDays)} active days</span>
        <span className="model">{shortModel(s.favoriteModel)}</span>
      </div>

      {s.planLimits && s.planLimits.available && s.planLimits.bars.length > 0 && (
        <div className="cs-limits">
          <div className="cs-limits-title">
            Plan usage limits{s.planLimits.plan ? ` · ${s.planLimits.plan}` : ""}
          </div>
          {s.planLimits.bars.map((bar) => (
            <div className="cs-bar-row" key={bar.id}>
              <div className="cs-bar-head">
                <span className="cs-bar-label">{bar.label}</span>
                {bar.usedPercent != null && (
                  <span className="cs-bar-pct">{bar.usedPercent}% used</span>
                )}
              </div>
              {bar.usedPercent != null && (
                <div className="cs-bar-track">
                  <div
                    className="cs-bar-fill"
                    style={{ width: `${bar.usedPercent}%`, background: barColor(bar.usedPercent) }}
                  />
                </div>
              )}
              {timeElapsedPercent(bar) != null && (
                <div className="cs-time-track" title="Time elapsed in this window">
                  <div className="cs-time-fill" style={{ width: `${timeElapsedPercent(bar)}%` }} />
                </div>
              )}
              <div className="cs-bar-reset">{resetText(bar)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

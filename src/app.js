import { setDefaultResultOrder } from 'node:dns';
import { APP_NAME, SIGNAL_SERVER_URL, SIGNAL_POLL_MS, POSITION_CHECK_MS, PUMPPORTAL_API_KEY, PUMPPORTAL_ENABLED, PREGRAD_ENABLED, TRENDING_POLL_MS, validateConfig } from './config.js';
import { initDb } from './db/connection.js';
import { initLiveExecution } from './liveExecutor.js';
import { setupTelegram } from './telegram/commands.js';
import { monitorPositions } from './execution/positions.js';
import { processCandidateFromSignals, maybeProcessDegenCandidate } from './pipeline/orchestrator.js';
import { sendTelegram } from './telegram/send.js';
import { makeFailureTracker } from './utils.js';
import { singleFlight } from './utils/singleFlight.js';

setDefaultResultOrder('ipv4first');
validateConfig();

export async function startCharon() {
  initDb();
  initLiveExecution();
  setupTelegram();

  if (SIGNAL_SERVER_URL) {
    // ── Server mode: fetch signals from signal server ──────────────────────
    const { fetchServerSignals, setCandidateHandler, setDegenHandler } = await import('./signals/serverClient.js');

    setCandidateHandler(processCandidateFromSignals);
    setDegenHandler(maybeProcessDegenCandidate);

    const alert = (msg) => sendTelegram(msg);
    const trackServer = makeFailureTracker('server signals', alert);
    const trackDip = makeFailureTracker('dip monitor', alert);

    const serverCycle = singleFlight(fetchServerSignals);
    serverCycle().catch(error => console.log(`[server] initial fetch failed: ${error.message}`));
    setInterval(() => trackServer(serverCycle), SIGNAL_POLL_MS);

    // GMGN Trenches polling (runs alongside server signals)
    const { fetchTrenches, setCandidateHandler: setTrenchesHandler } = await import('./signals/trenches.js');
    setTrenchesHandler(processCandidateFromSignals);
    const trackTrenches = makeFailureTracker('gmgn trenches', alert);
    const trenchesCycle = singleFlight(fetchTrenches);
    trenchesCycle().catch(error => console.log(`[trenches] initial fetch failed: ${error.message}`));
    // Reduced from 30s to 60s — pump.fun direct source is faster and more reliable
    setInterval(() => trackTrenches(trenchesCycle), 60_000);

    // Price monitor for dip buy strategy
    const { monitorPriceAlerts, cleanupAlerts } = await import('./signals/priceMonitor.js');
    const { setCandidateHandler: setAlertHandler } = await import('./signals/priceMonitor.js');
    setAlertHandler(processCandidateFromSignals);
    setInterval(() => trackDip(() => monitorPriceAlerts()), 10_000);
    setInterval(() => cleanupAlerts(), 60 * 60 * 1000);

    console.log(`[bot] ${APP_NAME} started (server mode: ${SIGNAL_SERVER_URL})`);
  } else {
    // ── Trenches-only mode: direct polling of GMGN trenches ─────────────────
    const { fetchTrenches, setCandidateHandler } = await import('./signals/trenches.js');

    setCandidateHandler(processCandidateFromSignals);

    const trenchesCycle = singleFlight(fetchTrenches);
    trenchesCycle().catch(error => console.log(`[trenches] initial fetch failed: ${error.message}`));
    // Reduced from 30s to 60s — pump.fun direct source is faster and more reliable
    setInterval(() => trenchesCycle().catch(error => console.log(`[trenches] ${error.message}`)), 60_000);

    console.log(`[bot] ${APP_NAME} started (trenches-only mode)`);
  }

  // Graduation polling — runs in both modes (GMGN /v1/token/info based detection)
  const { startGraduationPolling, fetchGraduatedCoins } = await import('./signals/graduated.js');
  const trackGraduation = makeFailureTracker('graduation poll', (msg) => sendTelegram(msg));
  const graduatedFetchCycle = singleFlight(fetchGraduatedCoins);
  graduatedFetchCycle().catch(err => console.log(`[graduated] initial fetch failed: ${err.message}`));
  setInterval(() => trackGraduation(graduatedFetchCycle), 60_000);
  startGraduationPolling();

  // Trending polling — runs in both modes
  const { fetchGmgnTrending, setTrendingCandidateHandler } = await import('./signals/trending.js');
  setTrendingCandidateHandler(processCandidateFromSignals);
  const trackTrending = makeFailureTracker('trending poll', (msg) => sendTelegram(msg));
  const trendingCycle = singleFlight(fetchGmgnTrending);
  trendingCycle().catch(err => console.log(`[trending] initial fetch failed: ${err.message}`));
  setInterval(() => trackTrending(trendingCycle), TRENDING_POLL_MS);

  if (PREGRAD_ENABLED) {
    const { startPumpfunPregrad, setCandidateHandler: setPregradHandler } = await import('./signals/pumpfunPregrad.js');
    setPregradHandler(processCandidateFromSignals);
    const trackPregrad = makeFailureTracker('pumpfun pregrad', (msg) => sendTelegram(msg));
    startPumpfunPregrad(trackPregrad);
  }

  if (PUMPPORTAL_API_KEY && PUMPPORTAL_ENABLED) {
    const { startPumpportal, setCandidateHandler: setPumpportalHandler } = await import('./signals/pumpportal.js');
    setPumpportalHandler(processCandidateFromSignals);
    startPumpportal();
  }

  // Position monitoring runs in both modes
  const trackPositions = makeFailureTracker('position monitor', (msg) => sendTelegram(msg));
  let positionMonitorRunning = false;
  setInterval(async () => {
    if (positionMonitorRunning) return;
    positionMonitorRunning = true;
    try {
      await trackPositions(() => monitorPositions());
    } finally {
      positionMonitorRunning = false;
    }
  }, POSITION_CHECK_MS);
}

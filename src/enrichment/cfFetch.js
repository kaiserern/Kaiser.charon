import axios from 'axios';

// pump.fun answers 403 "Just a moment" (Cloudflare) to this host, which killed the
// pregrad and graduated REST routes. /opt/charon-cf/fetchd.py serves a Chromium
// worker that clears the challenge; this is the only path to it. The daemon is a
// systemd unit (charon-cf-fetch, Restart=always), so we never spawn it from here.
export const CF_FETCH_URL = process.env.CHARON_CF_FETCH_URL || 'http://127.0.0.1:8799';

let lastFailureLog = 0;

export async function cfFetchJson(target) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await axios.get(`${CF_FETCH_URL}/fetch`, {
        params: { url: target },
        timeout: 80_000,
      });
      return res.data?.body ?? null;
    } catch (err) {
      const status = err.response?.status;
      if (status === 400) return null;
      // 502 = challenge not cleared, timeout = browser busy; one retry is enough and
      // keeps the log quiet instead of flooding a failing cycle.
      if (attempt === 1) {
        if (Date.now() - lastFailureLog > 60_000) {
          lastFailureLog = Date.now();
          console.log(`[cf-fetch] ${status || err.code || err.message} ${target.slice(0, 60)}`);
        }
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 700));
    }
  }
  return null;
}

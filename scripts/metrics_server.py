#!/usr/bin/env python3
"""Charon metrics for Grafana JSON API datasource — per-endpoint, array format."""
import sqlite3, json, time, os
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

DB = "/home/ubuntu/projects/charon/charon.sqlite"


def q(sql, params=()):
    conn = sqlite3.connect('file:'+DB+'?mode=ro', uri=True, timeout=2)
    conn.execute('PRAGMA query_only=ON')
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute(sql, params)]
    conn.close()
    return rows


def endpoint_pnl_summary():
    now_ms = int(time.time() * 1000)
    day_ms = 86400000
    results = []
    for label, cutoff in [("24h", now_ms - day_ms), ("7d", now_ms - 7 * day_ms), ("all", 0)]:
        r = q("""SELECT 
            COUNT(*) as total, ROUND(AVG(pnl_sol),4) as avg_pnl,
            ROUND(SUM(pnl_sol),4) as total_pnl,
            SUM(CASE WHEN pnl_sol>0 THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN pnl_sol<0 THEN 1 ELSE 0 END) as losses
        FROM office_position_quality WHERE id>(SELECT legacy_max_id FROM office_quality_policy WHERE id=1) AND quality_status='quote_backed_assumed_fees' AND execution_mode=COALESCE((SELECT value FROM settings WHERE key='trading_mode'),'dry_run') AND status='closed' AND closed_at_ms > ?""", (cutoff,))
        if r and r[0]["total"]:
            r[0]["period"] = label
            r[0]["basis"] = "quote_backed_assumed_fees"
            r[0]["wr"] = round(100 * r[0]["wins"] / max(r[0]["total"], 1), 1)
            results.append(r[0])
    return results


def endpoint_pnl_timeline():
    return q("""SELECT 
        datetime(closed_at_ms/1000,'unixepoch') as time,
        ROUND(pnl_sol,4) as pnl_sol, exit_reason
    FROM office_position_quality WHERE id>(SELECT legacy_max_id FROM office_quality_policy WHERE id=1) AND quality_status='quote_backed_assumed_fees' AND execution_mode=COALESCE((SELECT value FROM settings WHERE key='trading_mode'),'dry_run') AND status='closed' 
    AND closed_at_ms > (strftime('%s','now')-604800)*1000
    ORDER BY closed_at_ms ASC""")


def endpoint_routes():
    return q("""SELECT 
        json_extract(snapshot_json,'$.candidate.signals.route') as route,
        COUNT(*) as trades, ROUND(SUM(pnl_sol),4) as total_pnl
    FROM office_position_quality WHERE id>(SELECT legacy_max_id FROM office_quality_policy WHERE id=1) AND quality_status='quote_backed_assumed_fees' AND execution_mode=COALESCE((SELECT value FROM settings WHERE key='trading_mode'),'dry_run') AND status='closed'
    AND closed_at_ms > (strftime('%s','now')-604800)*1000
    GROUP BY route ORDER BY total_pnl ASC""")


def endpoint_recent_trades():
    return q("""SELECT symbol, ROUND(pnl_sol,4) as pnl_sol, 
        ROUND(pnl_percent,1) as pnl_pct, exit_reason,
        datetime(closed_at_ms/1000,'unixepoch') as closed_at
    FROM office_position_quality WHERE id>(SELECT legacy_max_id FROM office_quality_policy WHERE id=1) AND quality_status='quote_backed_assumed_fees' AND execution_mode=COALESCE((SELECT value FROM settings WHERE key='trading_mode'),'dry_run') AND status='closed'
    ORDER BY closed_at_ms DESC LIMIT 20""")


def endpoint_candidates():
    r = q("""SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status='buy' THEN 1 ELSE 0 END) as buys,
        SUM(CASE WHEN status='filtered' THEN 1 ELSE 0 END) as filtered
    FROM candidates WHERE created_at_ms > (strftime('%s','now')-86400)*1000""")
    return r if r else [{"total": 0, "buys": 0, "filtered": 0}]


def endpoint_open_positions():
    r = q("SELECT COUNT(*) as count FROM dry_run_positions WHERE status='open'")
    return r if r else [{"count": 0}]


ENDPOINTS = {
    "/pnl-summary": endpoint_pnl_summary,
    "/pnl-timeline": endpoint_pnl_timeline,
    "/routes": endpoint_routes,
    "/recent-trades": endpoint_recent_trades,
    "/candidates": endpoint_candidates,
    "/open-positions": endpoint_open_positions,
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = urlparse(self.path).path
        if path in ENDPOINTS:
            try:
                data = ENDPOINTS[path]()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps(data).encode())
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        elif path == "/health":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"OK")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "9191"))
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
# Serwer deweloperski: jak http.server, ale z Cache-Control: no-store,
# zeby przegladarka nie trzymala starych modulow ES podczas pracy nad kodem.
# Uzycie: python scripts/dev-server.py [port]
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    print(f"dev-server (no-store) na http://localhost:{port}")
    HTTPServer(("127.0.0.1", port), NoCacheHandler).serve_forever()

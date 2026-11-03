"""Fetch games with centisecond clocks from Lichess, by game ID.

usage: python fetch_games.py <ids.txt> <out.ndjson> <count> [start]

Appends to out.ndjson. Uses POST /api/games/export/_ids (300 IDs a request,
no token needed). The per-user export answers 404 to anonymous requests, and
the monthly database only has whole-second clocks, which cannot tell a premove
(0.00 s) from a fast move.
"""
import sys, time, urllib.request
ids_file, out_file, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
start = int(sys.argv[4]) if len(sys.argv) > 4 else 0
ids = [l.split()[0] for l in open(ids_file)][start:start + n]
with open(out_file, 'a', encoding='utf-8') as out:
    for i in range(0, len(ids), 300):
        body = ','.join(ids[i:i + 300]).encode()
        req = urllib.request.Request('https://lichess.org/api/games/export/_ids?clocks=true&moves=true&opening=false',
                                     data=body, headers={'Accept': 'application/x-ndjson'})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    out.write(r.read().decode()); break
            except urllib.error.HTTPError as e:
                print('HTTP', e.code, 'waiting 60s', flush=True); time.sleep(60)
        print(f'{i + 300}/{len(ids)}', flush=True)

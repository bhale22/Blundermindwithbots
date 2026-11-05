"""Pick bullet game IDs from the head of a Lichess monthly database file.

usage: python fetch_ids.py <db url> <megabytes> <out ids.txt> [time control]

Streams only the first <megabytes> of the .pgn.zst (40 MB is ~120k games) and
keeps rated games in the given time control (default 60+0) with at least 30
plies. Each line of the output is "<id> <white elo> <black elo> <plies>".

The database files open with a zstd skippable frame, so decompression has to
restart on each frame's unused_data rather than stopping at the first EOF.
"""
import re, sys, urllib.request
import compression.zstd as zstd   # Python 3.14+

url, megabytes, out_path = sys.argv[1], int(sys.argv[2]), sys.argv[3]
tc_wanted = sys.argv[4] if len(sys.argv) > 4 else '60+0'

req = urllib.request.Request(url, headers={'Range': f'bytes=0-{megabytes * 1_000_000}'})
data = urllib.request.urlopen(req).read()

parts, rest = [], data
while rest:
    d = zstd.ZstdDecompressor(options={zstd.DecompressionParameter.window_log_max: 31})
    try:
        parts.append(d.decompress(rest))
    except zstd.ZstdError:
        break                       # the cut-off end of the range
    if not d.eof:
        break
    rest = d.unused_data
text = b''.join(parts).decode('utf-8', errors='replace')

kept = []
for g in text.split('\n\n[Event ')[:-1]:      # the last game is cut off mid-move
    if 'Rated Bullet' not in g[:60]:
        continue
    tc = re.search(r'TimeControl "([^"]+)"', g)
    if not tc or tc.group(1) != tc_wanted:
        continue
    gid = re.search(r'lichess\.org/(?:game/)?(\w{8})', g)
    we = re.search(r'WhiteElo "(\d+)"', g)
    be = re.search(r'BlackElo "(\d+)"', g)
    plies = len(re.findall(r'\[%clk', g))
    if gid and we and be and plies >= 30:
        kept.append(f'{gid.group(1)} {we.group(1)} {be.group(1)} {plies}')

open(out_path, 'w').write('\n'.join(kept))
print(f'{len(kept)} {tc_wanted} games kept')

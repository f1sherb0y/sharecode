import itertools
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/sharecode-visibility-test/samples.jsonl')
samples = [json.loads(line) for line in path.read_text().splitlines()]
for key, group in itertools.groupby(samples, key=lambda s: (s['running'], s['source'].get('phase'))):
    group = list(group)
    if not key[0]:
        continue
    # Exclude transition frames at both ends of each state.
    stable = [s for s in group if group[0]['time'] + 2000 <= s['time'] <= group[-1]['time'] - 500]
    if len(stable) < 2:
        continue
    first, last = stable[0], stable[-1]
    print(json.dumps({
        'phase': key[1], 'seconds': round((last['time'] - first['time']) / 1000, 2),
        'sourceEnqueued': last['source']['enqueued'] - first['source']['enqueued'],
        'videoFrames': last['frames'] - first['frames'],
        'pixelChanges': last['changes'] - first['changes'],
        'uniqueHashes': len({s['hash'] for s in stable}),
        'trackStates': sorted({s['track']['state'] for s in stable if s['track']}),
        'sourceState': {k: last['source'][k] for k in ('visible', 'miniaturized', 'appHidden', 'frame')},
    }))

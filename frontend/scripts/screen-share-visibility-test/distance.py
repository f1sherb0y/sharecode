"""Run after selecting the synthetic window in the local Chrome test page."""
import json
import os
import pathlib
import sys
import time

root = pathlib.Path('/tmp/sharecode-visibility-test')
positions = [float(x) for x in sys.argv[1:]] or [2000, 10000, 32767, 65535, 100000, 1000000, 10000000, 100000000, 1000000000]
try:
    for x in positions:
        if os.environ.get('REBASE_POSITION'):
            (root / 'command').write_text('rawx:10000')
            time.sleep(0.5)
        started = time.time()
        phase = f'{os.environ.get("POSITION_MODE", "x")}:{x:.17g}'
        (root / 'command').write_text(phase)
        time.sleep(6)
        samples = [json.loads(line) for line in (root / 'samples.jsonl').read_text().splitlines()]
        stable = [s for s in samples if s['source']['phase'] == phase and s['time'] >= (started + 2) * 1000]
        if len(stable) < 4:
            raise RuntimeError(f'Insufficient fresh measurements for {phase}')
        a, b = stable[0], stable[-1]
        result = dict(phase=phase, requestedX=x, actualX=b['source']['actualX'], serverBounds=b['source']['serverBounds'],
                      seconds=(b['time']-a['time'])/1000, frames=b['frames']-a['frames'],
                      pixelChanges=b['changes']-a['changes'], sourceFrames=b['source']['enqueued']-a['source']['enqueued'],
                      track=b['track'])
        print(json.dumps(result), flush=True)
        with (root / 'distance-results.jsonl').open('a') as file:
            file.write(json.dumps(result) + '\n')
        if (b['source']['actualX'] != x or b['source']['serverBounds'].get('X') != x) and not os.environ.get('CONTINUE_CLAMPED'):
            print('Position was clamped or rounded; stopping this sweep.', flush=True)
            break
finally:
    # Return to the ordinary AppKit-clamped off-screen position after each sweep.
    (root / 'command').write_text('x:10000')

import json,time,pathlib,argparse
parser=argparse.ArgumentParser();parser.add_argument("--output",default="build/capture-benchmark/adaptive");args=parser.parse_args()
root=pathlib.Path('/tmp/sharecode-capture-benchmark')
observations=[]
def command(s): root.joinpath('command').write_text(s)
def observe(seconds):
 result=[];last=None;end=time.monotonic()+seconds
 while time.monotonic()<end:
  s=json.loads(root.joinpath('status.json').read_text())
  if s['timestamp']!=last: result.append(s);last=s['timestamp']
  time.sleep(.05)
 return result
def fps(a):return (a[-1]['frames']-a[0]['frames'])/(a[-1]['timestamp']-a[0]['timestamp'])
try:
 command('snapshot:static:3840');observe(3)
 idle=observe(3);assert 3.5<fps(idle)<6.5, idle
 command('motion:pixel');pixel=observe(2.2) # status is published once/second; include a complete post-command interval
 gaps=[g for s in pixel for g in s['gapMs']]
 assert any(g<50 for g in gaps), ('Single-pixel change did not wake fast polling',gaps)
 observe(3);idleAgain=observe(3);assert 3.5<fps(idleAgain)<6.5
 command('motion:dynamic');observe(1);dynamic=observe(3);assert fps(dynamic)>25, dynamic
 assert all(s['errors']==0 and s['invalid']==0 for s in idle+pixel+idleAgain+dynamic)
 if args.output.endswith('/gpu'): assert dynamic[-1]['metalComparisons']>0 and dynamic[-1]['cpuComparisons']==0
 result={'idleFps':fps(idle),'singlePixelFollowingGapsMs':gaps,'idleAgainFps':fps(idleAgain),'dynamicFps':fps(dynamic),'states':idle+pixel+idleAgain+dynamic}
 (pathlib.Path(args.output)/'transitions.json').write_text(json.dumps(result,indent=2))
 print(json.dumps({k:v for k,v in result.items() if k!='states'}),flush=True)
finally: command('quit')

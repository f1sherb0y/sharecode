import json,time,subprocess,plistlib,pathlib,statistics,argparse
parser=argparse.ArgumentParser();parser.add_argument("--sparse",action="store_true");parser.add_argument("--gpu",action="store_true");parser.add_argument("--adaptive",action="store_true");parser.add_argument("--seconds",type=float,default=13);args=parser.parse_args()
root=pathlib.Path('/tmp/sharecode-capture-benchmark');out=pathlib.Path('build/capture-benchmark'); rows=[]; results=[]
def proc():
 d={}
 for l in subprocess.check_output(['ps','-axo','pid,time,rss,comm'],text=True).splitlines()[1:]:
  p,t,r,c=l.strip().split(None,3);v=0
  for x in t.split(':'):v=v*60+float(x)
  key='app' if c.endswith('/CaptureBenchmark') else 'windowserver' if c.endswith('/WindowServer') else 'replayd' if c.endswith('/replayd') else None
  if key:d[key]=(v,int(r)/1024)
 return d
def avg(x):return round(statistics.mean(x),2) if x else None
def pct(x,p):return round(sorted(x)[min(len(x)-1,int(len(x)*p))],2) if x else None
phases=['idle:static:1920','stream:static:1920','snapshot:static:1920','snapshot:dynamic:1920','stream:dynamic:1920','snapshot:static:3840','stream:static:3840','stream:dynamic:3840','snapshot:dynamic:3840']
if args.adaptive:
 out=out/'adaptive';out.mkdir(exist_ok=True)
 phases=['snapshot-fixed:static:1920','snapshot:static:1920','snapshot:dynamic:1920','snapshot-fixed:dynamic:1920','snapshot:static:3840','snapshot-fixed:static:3840','snapshot-fixed:dynamic:3840','snapshot:dynamic:3840']
if args.gpu:
 out=out/'gpu';out.mkdir(exist_ok=True)
 phases=['snapshot-cpu:static:1920','snapshot:static:1920','snapshot:dynamic:1920','snapshot-cpu:dynamic:1920','snapshot:static:3840','snapshot-cpu:static:3840','snapshot-cpu:dynamic:3840','snapshot:dynamic:3840','snapshot-cpu:blink:3840','snapshot:blink:3840']
if args.sparse:
 out=out/'gpu-sparse';out.mkdir(exist_ok=True)
 phases=['snapshot-cpu:blink:3840','snapshot:blink:3840']
with (out/'metrics.jsonl').open('w') as f:
 for phase in phases:
  root.joinpath('command').write_text(phase); start=time.monotonic();prev=proc();pt=time.monotonic();samples=[];seen=set();gaps=[];lat=[];first=None;last=None
  while time.monotonic()-start<args.seconds:
   time.sleep(1);q=proc();t=time.monotonic();s=json.loads(root.joinpath('status.json').read_text());b=plistlib.loads(subprocess.check_output(['ioreg','-a','-r','-c','AppleSmartBattery']))[0]
   row={'phase':phase,'seconds':t-start,'status':s,'cpu':{k:100*(v[0]-prev.get(k,v)[0])/(t-pt) for k,v in q.items()},'rssMiB':{k:v[1] for k,v in q.items()},'batteryWatts':-b.get('Amperage',0)*b.get('Voltage',0)/1e6,'systemWatts':b.get('PowerTelemetryData',{}).get('SystemLoad',0)/1000,'batteryPercent':b.get('CurrentCapacity'),'externalPower':b.get('ExternalConnected')}
   prev=q;pt=t;rows.append(row);f.write(json.dumps(row)+'\n');f.flush()
   if t-start>=3 and phase==f"{s['mode']}:{s['motion']}:{s['width']}":
    samples.append(row)
    if first is None:first=s
    last=s
    if s['timestamp'] not in seen:gaps+=s['gapMs'];lat+=s['latencyMs'];seen.add(s['timestamp'])
  r={'phase':phase,'samples':len(samples),'cpu':{k:avg([r['cpu'].get(k,0) for r in samples]) for k in ['app','windowserver','replayd']},'rssMiB':{k:avg([r['rssMiB'].get(k,0) for r in samples]) for k in ['app','windowserver','replayd']},'batteryWatts':avg([r['batteryWatts'] for r in samples]),'systemWatts':avg([r['systemWatts'] for r in samples]),'gapP95Ms':pct(gaps,.95),'maxGapMs':max(gaps) if gaps else None,'latencyP50Ms':pct(lat,.5),'latencyP95Ms':pct(lat,.95),'latencySamples':len(lat),'last':last}
  if first and last:r['fps']=(last['frames']-first['frames'])/(last['timestamp']-first['timestamp']);r['appMemoryChangeMiB']=samples[-1]['rssMiB']['app']-samples[0]['rssMiB']['app']
  results.append(r);(out/'results.json').write_text(json.dumps(results,indent=2));print(json.dumps({k:v for k,v in r.items() if k!='last'}),flush=True)
root.joinpath('command').write_text('quit')

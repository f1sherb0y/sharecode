import { describe, test, expect } from 'bun:test'
import * as Y from 'yjs'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import { CanvasSync, orderedCanvasElements, canvasFiles, containViewport } from '../src/lib/canvas-sync'
import { DocumentReplay } from '../src/lib/document-replay'

const shape = (id: string, version = 1, props = {}) => ({ id, type: 'rectangle', index: `a${id}`, version, versionNonce: version, isDeleted: false, x: 0, y: 0, ...props }) as unknown as ExcalidrawElement
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('Canvas data protocol (no drawing UI simulation)', () => {
  test('concurrent unrelated edits, same-element conflicts, deletion, undo and duplicate delivery converge', () => {
    const a = new Y.Doc(), b = new Y.Doc()
    const sa = new CanvasSync(a), sb = new CanvasSync(b)
    sa.stage([shape('A')], {}, null); sa.flush()
    sb.stage([shape('B')], {}, null); sb.flush()
    const ua = Y.encodeStateAsUpdate(a), ub = Y.encodeStateAsUpdate(b)
    Y.applyUpdate(a, ub); Y.applyUpdate(b, ua); Y.applyUpdate(a, ub)
    expect(orderedCanvasElements(a)).toEqual(orderedCanvasElements(b))
    sa.acceptRemote(orderedCanvasElements(a)); sb.acceptRemote(orderedCanvasElements(b))
    sa.stage([shape('A', 2, { x: 10 }), shape('B')], {}, null); sa.flush()
    sb.stage([shape('A', 2, { x: 20 }), shape('B')], {}, null); sb.flush()
    const va = Y.encodeStateAsUpdate(a), vb = Y.encodeStateAsUpdate(b)
    Y.applyUpdate(a, vb); Y.applyUpdate(b, va)
    expect(orderedCanvasElements(a)).toEqual(orderedCanvasElements(b))
    sa.acceptRemote(orderedCanvasElements(a))
    sa.stage(orderedCanvasElements(a).map(e => e.id === 'A' ? {...e, version:3, isDeleted:true} : e), {}, null); sa.flush()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); expect(orderedCanvasElements(b)[0].isDeleted).toBe(true)
    sa.stage(orderedCanvasElements(a).map(e => e.id === 'A' ? {...e, version:4, isDeleted:false} : e), {}, null); sa.flush()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); expect(orderedCanvasElements(a)).toEqual(orderedCanvasElements(b))
    expect(orderedCanvasElements(b)[0].isDeleted).toBe(false)
    sa.destroy(); sb.destroy(); a.destroy(); b.destroy()
  })

  test('1000Hz events are coalesced before Yjs writes; freehand appends bounded deltas and retains the endpoint', async () => {
    const d = new Y.Doc(), updates: Uint8Array[] = [], pending: boolean[] = []
    d.on('update', u => updates.push(u))
    const s = new CanvasSync(d, p => pending.push(p))
    for (let i = 1; i <= 120; i++) {
      s.stage([shape('stroke', i, {type:'freedraw', points:Array.from({length:i*100}, (_, n) => [n,n%17]), pressures:[], simulatePressure:true})], {}, 'stroke')
      await pause(1)
    }
    s.flush()
    expect(updates.length).toBeLessThanOrEqual(5)
    const element = orderedCanvasElements(d)[0] as any
    expect(element.points.length).toBeLessThanOrEqual(updates.length * 6)
    expect(element.points.at(-1)).toEqual([11999,11999%17])
    expect(Math.max(...updates.map(u => u.length))).toBeLessThan(3000)
    expect(pending.at(-1)).toBe(false)
    s.destroy(); d.destroy()
  })

  test('a long stroke sends linear-sized point deltas, including pressure; concurrent transforms do not mix generations', () => {
    const a = new Y.Doc(), b = new Y.Doc(), updates: Uint8Array[] = []
    const s = new CanvasSync(a)
    a.on('update', u => updates.push(u))
    for(let i=1;i<=100;i++) {
      s.stage([shape('S',i,{type:'freedraw',points:Array.from({length:i*60},(_,n)=>[n,n]),pressures:Array(i*60).fill(.7),simulatePressure:false})],{},'S');s.flush()
    }
    expect(updates.at(-1)!.length).toBeLessThan(2000)
    const final = orderedCanvasElements(a)[0] as any
    expect(final.points.length).toBe(600); expect(final.pressures.length).toBe(600)
    // Replay out-of-order Yjs updates is safe too.
    for(const update of updates.toReversed()) Y.applyUpdate(b,update)
    expect(orderedCanvasElements(b)).toEqual(orderedCanvasElements(a))
    const other = new CanvasSync(b)
    s.acceptRemote(orderedCanvasElements(a))
    s.stage([shape('S',101,{...final,version:101,points:final.points.map(([x,y]:number[])=>[x*2,y*2])})],{},null);s.flush()
    other.stage([shape('S',101,{...final,version:101,points:final.points.map(([x,y]:number[])=>[x*3,y*3])})],{},null);other.flush()
    const ua=Y.encodeStateAsUpdate(a),ub=Y.encodeStateAsUpdate(b);Y.applyUpdate(a,ub);Y.applyUpdate(b,ua)
    expect(orderedCanvasElements(a)).toEqual(orderedCanvasElements(b))
    s.destroy();other.destroy();a.destroy();b.destroy()
  })

  test('remote application never creates local echo; pending edits survive remote unrelated data', () => {
    const d=new Y.Doc(), s=new CanvasSync(d)
    const remote=[shape('A')];s.acceptRemote(remote)
    let writes=0;d.on('update',()=>writes++)
    s.stage(remote,{},null);s.flush();expect(writes).toBe(0)
    s.stage([shape('A',2)],{},null);s.acceptRemote([shape('B')]);s.flush()
    expect(orderedCanvasElements(d)[0].version).toBe(2)
    s.destroy();d.destroy()
  })

  test('import replacement tombstones removed elements and image payloads are written only once', () => {
    const d=new Y.Doc(),s=new CanvasSync(d)
    const files={img:{id:'img',mimeType:'image/png',created:1,dataURL:'data:image/png;base64,AA=='}} as any
    s.stage([shape('A'),shape('img',1,{type:'image',fileId:'img'})],files,null);s.flush()
    expect(Object.keys(canvasFiles(d))).toEqual(['img'])
    let bytes=0;d.on('update',u=>bytes+=u.length)
    s.stage([shape('img',2,{type:'image',fileId:'img',x:10})],files,null);s.flush()
    expect(orderedCanvasElements(d).find(e=>e.id==='A')?.isDeleted).toBe(true)
    expect(bytes).toBeLessThan(1000)
    expect(()=>s.stage([shape('large',1,{type:'image',fileId:'large'})],{large:{...files.img,id:'large',dataURL:'x'.repeat(350001)}},null)).toThrow('fileTooLarge')
    s.destroy();d.destroy()
  })

  test('replay shares code/canvas/image history, seeks backward, and does not reapply prior updates going forward', () => {
    const d=new Y.Doc(),updates:{timestampMs:number;update:Uint8Array}[]=[]
    let time=1;d.on('update',u=>updates.push({timestampMs:time++,update:u}))
    d.getText('codemirror').insert(0,'hello')
    const s=new CanvasSync(d);s.stage([shape('A')],{},null);s.flush()
    s.stage([shape('A',2,{x:100})],{},null);s.flush()
    const r=new DocumentReplay(updates)
    expect(r.seek(1).getText('codemirror').toString()).toBe('hello')
    expect(orderedCanvasElements(r.doc)).toHaveLength(0)
    r.seek(2);expect(orderedCanvasElements(r.doc)[0].x).toBe(0)
    const same=r.doc;r.seek(3);expect(r.doc).toBe(same);expect(orderedCanvasElements(r.doc)[0].x).toBe(100)
    r.seek(1);expect(r.doc).not.toBe(same);expect(orderedCanvasElements(r.doc)).toHaveLength(0)
    r.seek(3);expect(orderedCanvasElements(r.doc)).toEqual(orderedCanvasElements(d))
    r.destroy();s.destroy();d.destroy()
  })

  test('Follow exactly contains and centers presenter viewport across aspect ratios and DPI', () => {
    const target={x:-320,y:140,width:1280,height:720}
    for(const [width,height] of [[1920,1080],[390,844],[2732,2048],[320,200],[700,1200]]) {
      const fit=containViewport(target,width,height)!
      const actualWidth=width/fit.zoom, actualHeight=height/fit.zoom
      expect(actualWidth+1e-6).toBeGreaterThanOrEqual(target.width)
      expect(actualHeight+1e-6).toBeGreaterThanOrEqual(target.height)
      expect(Math.min(actualWidth/target.width,actualHeight/target.height)).toBeCloseTo(1)
      expect(-fit.scrollX+actualWidth/2).toBeCloseTo(target.x+target.width/2)
      expect(-fit.scrollY+actualHeight/2).toBeCloseTo(target.y+target.height/2)
    }
    expect(containViewport({...target,width:0},390,844)).toBeNull()
    expect(containViewport({...target,x:NaN},390,844)).toBeNull()
  })
})

import numpy as np, soundfile as sf, json
SR=44100
lines=[l.strip() for l in open('lines.txt') if l.strip()]
scene_of=[1,1,2,2,3,3,3,4,4,5,6,6]
def load(i):
    a,sr=sf.read(f'assets/vo/l{i}.wav'); a=a if a.ndim==1 else a.mean(1)
    # resample to SR
    n=int(len(a)*SR/sr); a=np.interp(np.linspace(0,len(a)-1,n),np.arange(len(a)),a)
    # trim silence
    th=0.01*np.abs(a).max(); idx=np.where(np.abs(a)>th)[0]; a=a[max(0,idx[0]-200):idx[-1]+800]
    return a
t=0.35; segs=[]; prev=1
for i,l in enumerate(lines,1):
    if scene_of[i-1]!=prev: t+=0.45; prev=scene_of[i-1]
    a=load(i); segs.append((t,a,l,scene_of[i-1])); t+=len(a)/SR+0.22
T=t+1.4
vo=np.zeros(int(T*SR))
for s,a,_,_ in segs: i=int(s*SR); vo[i:i+len(a)]+=a
vo=vo/np.abs(vo).max()*0.89
# music: soft lofi chords, kick, hat
tt=np.arange(len(vo))/SR; bpm=82; beat=60/bpm; bar=4*beat
chords=[[261.63,329.63,392.0,493.88],[220.0,261.63,329.63,392.0],[174.61,220.0,261.63,329.63],[196.0,246.94,293.66,349.23]]
mus=np.zeros_like(vo)
for b in range(int(T/bar)+1):
    st=b*bar; ch=chords[b%4]; i0=int(st*SR); i1=min(len(mus),int((st+bar+0.3)*SR)); seg=tt[i0:i1]-st
    env=np.minimum(1,seg/0.6)*np.exp(-seg*0.25)
    for f in ch: mus[i0:i1]+=0.05*env*(np.sin(2*np.pi*f/2*seg)+0.3*np.sin(2*np.pi*f*seg))
    for k in range(4):
        ks=st+k*beat; j0=int(ks*SR); j1=min(len(mus),j0+int(0.25*SR)); s2=tt[j0:j1]-ks
        if k in (0,2): mus[j0:j1]+=0.35*np.sin(2*np.pi*(55+60*np.exp(-s2*30))*s2)*np.exp(-s2*14)
        hs=ks+beat/2; h0=int(hs*SR); h1=min(len(mus),h0+int(0.05*SR))
        if h0<len(mus): mus[h0:h1]+=0.04*np.random.default_rng(b*10+k).standard_normal(h1-h0)*np.exp(-np.arange(h1-h0)/SR*80)
    # arpeggio
    for k in range(8):
        ns=st+k*bar/8; f=ch[k%4]*2; j0=int(ns*SR); j1=min(len(mus),j0+int(0.4*SR)); s2=tt[j0:j1]-ns
        mus[j0:j1]+=0.025*np.sin(2*np.pi*f*s2)*np.exp(-s2*7)
# lowpass-ish smoothing
k=np.ones(6)/6; mus=np.convolve(mus,k,'same')
fade=np.minimum(1,tt/1.5)*np.minimum(1,(T-tt)/1.5)
mus*=fade
# ducking under voice
env=np.convolve(np.abs(vo),np.ones(4410)/4410,'same'); duck=1-0.55*np.clip(env/0.08,0,1)
mus=mus/np.abs(mus).max()*0.32*duck
# sfx
sfx=np.zeros_like(vo); rng=np.random.default_rng(7)
scene_starts=[]; prev=None
for s,a,l,sc in segs:
    if sc!=prev: scene_starts.append(round(s-0.3,3)); prev=sc
for s in scene_starts[1:]:
    i=int(s*SR); n=int(0.45*SR); w=rng.standard_normal(n); w=np.convolve(w,np.ones(30)/30,'same'); e=np.sin(np.pi*np.arange(n)/n)**2
    sfx[i:i+n]+=0.22*w*e
mix=vo*1.0+mus+sfx
mix=mix/max(1,np.abs(mix).max()/0.95)
sf.write('assets/mix.wav',np.stack([mix,mix],1),SR)
# word timings
data={'T':round(T,2),'scenes':[],'lines':[]}
for s,a,l,sc in segs:
    d=len(a)/SR; words=l.split(); w=[len(x)+1.5 for x in words]; tot=sum(w); c=s; ws=[]
    for x,wi in zip(words,w): dd=d*wi/tot; ws.append([x,round(c,3),round(c+dd,3)]); c+=dd
    data['lines'].append({'text':l,'start':round(s,3),'end':round(s+d,3),'scene':sc,'words':ws})
sc_list=sorted(set(scene_of))
for sc in sc_list:
    ls=[x for x in data['lines'] if x['scene']==sc]; st=ls[0]['start']-0.3 if sc>1 else 0
    data['scenes'].append({'id':sc,'start':round(st,3)})
for i,s in enumerate(data['scenes']): s['end']=data['scenes'][i+1]['start'] if i+1<len(data['scenes']) else data['T']
json.dump(data,open('timing.json','w'),indent=1)
print(data['T'],[(s['id'],s['start'],s['end']) for s in data['scenes']])

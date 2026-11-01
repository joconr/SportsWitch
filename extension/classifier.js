/*
 * SportsWitch 4.2.0: the 46 audio features and the weighted 600-tree forest trained by the 4.1.4 pipeline.
 * Input: mono 16 kHz audio. Output: [20 MFCC means, 20 MFCC stds, centroid mean/std, RMS mean/std, ZCR mean/std].
 * Fourier/mel/DCT parameters match librosa 0.11 defaults. The filters and DCT
 * have been precomputed with librosa/scipy and stored in spectral_constants.json.
 *
 * 4.2.0 reads every tab once a second, as the Android app does, instead of every five seconds. Two
 * streaming helpers make that affordable without changing a single number:
 * - StreamResampler gives the same samples downsample() gives, without re-resampling each window.
 * - FrameStream keeps each STFT frame once it is complete, so a reading only analyzes the frames at
 *   the edges of its window. Its features are bit-for-bit those of extractFeatures() on that window.
 * The forest now compares float32 features with its split thresholds, as scikit-learn does.
 */
(function (root) {
  'use strict';
  const RATE = 16000;
  const FFT_SIZE = 2048;
  const HOP = 512;
  const BIN_COUNT = FFT_SIZE / 2 + 1;
  const MEL_BANDS = 128;
  const MFCC_COUNT = 20;
  const FEATURE_COUNT = 46;
  const RMS_MEAN_INDEX = 42;
  /** The ad fingerprinter's hop: two of them per feature hop, sharing every other FFT. */
  const PRINT_HOP = 256;
  const HANN = Float64Array.from({length: FFT_SIZE}, (_, n) => 0.5 - 0.5 * Math.cos(2 * Math.PI * n / FFT_SIZE));
  const BITREV = new Uint16Array(FFT_SIZE);
  for (let i=0; i<FFT_SIZE; i++) {
    let j=0, v=i;
    for (let bit=0; bit<11; bit++) { j=(j<<1)|(v&1); v>>=1; }
    BITREV[i]=j;
  }
  const COS = [], SIN=[];
  for (let len=2; len<=FFT_SIZE; len*=2) {
    let a=new Float64Array(len/2), b=new Float64Array(len/2);
    for(let j=0;j<len/2;j++) {a[j]=Math.cos(2*Math.PI*j/len);b[j]=-Math.sin(2*Math.PI*j/len);}
    COS.push(a); SIN.push(b);
  }
  function fft(re, im) {
    for(let i=0;i<FFT_SIZE;i++) {
      const j=BITREV[i];
      if (j>i) {let t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}
    }
    let stage=0;
    for(let len=2;len<=FFT_SIZE;len*=2,stage++) {
      const c=COS[stage], s=SIN[stage];
      for(let i=0;i<FFT_SIZE;i+=len) {
        for(let j=0;j<len/2;j++) {
          const a=i+j, b=a+len/2, cr=c[j], si=s[j];
          const vr=re[b]*cr-im[b]*si, vi=re[b]*si+im[b]*cr;
          re[b]=re[a]-vr; im[b]=im[a]-vi;
          re[a]+=vr; im[a]+=vi;
        }
      }
    }
  }
  function stat(values) {
    let sum=0, square=0, n=values.length;
    for (let i=0;i<n;i++) sum+=values[i];
    const mean=sum/n;
    for (let i=0;i<n;i++) {const z=values[i]-mean; square+=z*z;}
    return [mean,Math.sqrt(square/n)];
  }
  function newScratch() {
    return {re:new Float64Array(FFT_SIZE), im:new Float64Array(FFT_SIZE), power:new Float64Array(BIN_COUNT)};
  }
  const SHARED = newScratch();
  function newFrame() {
    return {g:-1, melDb:new Float64Array(MEL_BANDS), maxDb:-Infinity, centroid:0, rms:0, zcr:0};
  }
  /*
   * One STFT frame. `zp` holds its 2048 samples as the STFT and RMS see them (zeros past the window),
   * `ep` as the zero-crossing rate does (the window's edge samples repeated): librosa pads the two
   * differently. Leaves the frame's power spectrum in scratch.power for the ad fingerprinter.
   */
  function frameSummary(zp, ep, constants, out, scratch=SHARED) {
    const {re, im, power}=scratch;
    let rmsSum=0, zeroCrosses=0, prevSample=0;
    for(let k=0;k<FFT_SIZE;k++) {
      const sample=zp[k];
      re[k]=sample*HANN[k]; im[k]=0;
      rmsSum+=sample*sample;
      const zSample=ep[k];
      if(k && ((prevSample<0)!==(zSample<0))) zeroCrosses++;
      prevSample=zSample;
    }
    out.rms=Math.sqrt(rmsSum/FFT_SIZE);
    out.zcr=zeroCrosses/FFT_SIZE;
    fft(re,im);
    let numerator=0,denominator=0;
    for(let k=0;k<BIN_COUNT;k++) {
      const p=re[k]*re[k]+im[k]*im[k];
      power[k]=p;
      const mag=Math.sqrt(p);
      denominator+=mag;
      numerator+=(RATE*k/FFT_SIZE)*mag;
    }
    out.centroid=denominator>0?numerator/denominator:0;
    const rows=constants.rows;
    let maxDb=-Infinity;
    for(let m=0;m<MEL_BANDS;m++) {
      const {start:melStart,weights}=rows[m];
      let sum=0;
      for(let i=0;i<weights.length;i++) sum+=weights[i]*power[melStart+i];
      const db=10*Math.log10(Math.max(1e-10,sum));
      out.melDb[m]=db;
      if(db>maxDb) maxDb=db;
    }
    out.maxDb=maxDb;
    return out;
  }
  /** The power spectrum alone, for fingerprint frames that are not also feature frames. */
  function powerSpectrum(samples, scratch=SHARED) {
    const {re, im, power}=scratch;
    for(let k=0;k<FFT_SIZE;k++) {re[k]=samples[k]*HANN[k]; im[k]=0;}
    fft(re,im);
    for(let k=0;k<BIN_COUNT;k++) power[k]=re[k]*re[k]+im[k]*im[k];
    return power;
  }
  /** The 46 features from a window's frames, in order. */
  function assemble(frames, constants) {
    const frameCount=frames.length, dct=constants.dct;
    let maxDb=-Infinity;
    for(const frame of frames) if(frame.maxDb>maxDb) maxDb=frame.maxDb;
    const dbFloor=maxDb-80;  // librosa.power_to_db top_db=80
    const mfccValues=Array.from({length:MFCC_COUNT},()=>new Float64Array(frameCount));
    const centroids=new Float64Array(frameCount);
    const rms=new Float64Array(frameCount);
    const zcr=new Float64Array(frameCount);
    for(let t=0;t<frameCount;t++) {
      const frame=frames[t], mel=frame.melDb;
      centroids[t]=frame.centroid; rms[t]=frame.rms; zcr[t]=frame.zcr;
      for(let c=0;c<MFCC_COUNT;c++) {
        let value=0;
        const coeff=dct[c];
        for(let m=0;m<MEL_BANDS;m++) {const db=mel[m]; value+=coeff[m]*(db<dbFloor?dbFloor:db);}
        mfccValues[c][t]=value;
      }
    }
    const result=[];
    for(let c=0;c<MFCC_COUNT;c++) result.push(stat(mfccValues[c])[0]);
    for(let c=0;c<MFCC_COUNT;c++) result.push(stat(mfccValues[c])[1]);
    result.push(...stat(centroids),...stat(rms),...stat(zcr));
    return result;
  }
  function extractFeatures(waveform, constants) {
    if (waveform.length < FFT_SIZE) throw new Error('Audio too short to classify');
    const n=waveform.length;
    const frameCount=1+Math.floor(n/HOP); // librosa center=True, n_fft even
    const zp=new Float64Array(FFT_SIZE), ep=new Float64Array(FFT_SIZE);
    const frames=new Array(frameCount);
    for(let frame=0; frame<frameCount; frame++) {
      const start=frame*HOP-FFT_SIZE/2;
      for(let k=0;k<FFT_SIZE;k++) {
        const index=start+k;
        // librosa 0.11 stft and rms center-pad with zeros; zero_crossing_rate pads with edges
        zp[k]=(index<0||index>=n)?0:waveform[index];
        ep[k]=waveform[Math.min(n-1,Math.max(0,index))];
      }
      frames[frame]=frameSummary(zp,ep,constants,newFrame());
    }
    return assemble(frames,constants);
  }
  function predictLive(features,forest) {
    if(features.length!==FEATURE_COUNT) throw new Error('Expected 46 features');
    // scikit-learn compares float32 features against its split thresholds.
    const x=new Float64Array(FEATURE_COUNT);
    for(let i=0;i<FEATURE_COUNT;i++) x[i]=Math.fround(features[i]);
    let sum=0,totalWeight=0;
    for(let treeIndex=0;treeIndex<forest.trees.length;treeIndex++) {
      const tree=forest.trees[treeIndex];
      const weight=forest.treeWeights?forest.treeWeights[treeIndex]:1;
      const [left,right,feature,threshold,pLive]=tree;
      let i=0;
      while(left[i]>=0) {
        i=x[feature[i]]<=threshold[i]?left[i]:right[i];
      }
      sum+=weight*pLive[i];
      totalWeight+=weight;
    }
    if(!(totalWeight>0))throw new Error('Model has no positive tree weights');
    return sum/totalWeight;
  }
  function downsample(samples,sourceRate,targetRate=RATE) {
    if(sourceRate===targetRate) return Float32Array.from(samples);
    const ratio=sourceRate/targetRate;
    const result=new Float32Array(Math.floor(samples.length/ratio));
    // Low-pass windowed-sinc resampler to suppress aliasing on 48k -> 16k.
    // A sinc kernel is needed for fairly matching librosa's high-quality resampler.
    const radius=24, cutoff=0.47*Math.min(1,targetRate/sourceRate);
    for(let i=0;i<result.length;i++) {
      const center=i*ratio, base=Math.floor(center);
      let total=0, weight=0;
      for(let j=-radius+1;j<=radius;j++) {
        const idx=base+j;
        if(idx<0||idx>=samples.length)continue;
        const dist=center-idx;
        const w=Math.abs(dist)<1e-12?2*cutoff:Math.sin(2*Math.PI*cutoff*dist)/(Math.PI*dist);
        const win=0.5+0.5*Math.cos(Math.PI*dist/radius);
        const c=w*win;
        total+=samples[idx]*c;weight+=c;
      }
      result[i]=weight!==0?total/weight:0;
    }
    return result;
  }
  /*
   * downsample() for a continuous stream. The kernel depends only on an output sample's fractional
   * source position, so it is cached (48 kHz input has a single phase). Away from the stream's start
   * every output equals what downsample() computes for that sample inside a longer window.
   */
  class StreamResampler {
    constructor(sourceRate,targetRate=RATE) {
      this.passthrough=sourceRate===targetRate;
      this.ratio=sourceRate/targetRate;
      this.radius=24;
      this.cutoff=0.47*Math.min(1,targetRate/sourceRate);
      this.kernels=new Map();
      this.buffer=new Float32Array(16384);
      this.reset();
    }
    reset() {
      this.start=0;   // stream index of buffer[0]
      this.length=0;  // samples held
      this.next=0;    // next output sample
    }
    kernel(phase) {
      let k=this.kernels.get(phase);
      if(k)return k;
      const radius=this.radius, cutoff=this.cutoff;
      k=new Float64Array(2*radius);
      for(let j=-radius+1;j<=radius;j++) {
        const dist=phase-j;
        const w=Math.abs(dist)<1e-12?2*cutoff:Math.sin(2*Math.PI*cutoff*dist)/(Math.PI*dist);
        k[j+radius-1]=w*(0.5+0.5*Math.cos(Math.PI*dist/radius));
      }
      if(this.kernels.size<4096)this.kernels.set(phase,k);
      return k;
    }
    process(input) {
      if(this.passthrough)return Float32Array.from(input);
      if(this.length+input.length>this.buffer.length){
        const bigger=new Float32Array(Math.max(this.buffer.length*2,this.length+input.length));
        bigger.set(this.buffer.subarray(0,this.length));
        this.buffer=bigger;
      }
      this.buffer.set(input,this.length);
      this.length+=input.length;
      const end=this.start+this.length, radius=this.radius;
      let result=new Float32Array(Math.ceil(input.length/this.ratio)+2), n=0;
      for(;;) {
        const center=this.next*this.ratio, base=Math.floor(center);
        if(base+radius>=end)break;
        const k=this.kernel(center-base);
        let total=0, weight=0;
        for(let j=-radius+1;j<=radius;j++) {
          const idx=base+j;
          if(idx<0)continue;
          const c=k[j+radius-1];
          total+=this.buffer[idx-this.start]*c;weight+=c;
        }
        if(n===result.length){const bigger=new Float32Array(n*2);bigger.set(result);result=bigger;}
        result[n++]=weight!==0?total/weight:0;
        this.next++;
      }
      // Keep only what the next output still needs.
      const keep=Math.max(this.start,Math.floor(this.next*this.ratio)-radius+1);
      if(keep>this.start){
        this.buffer.copyWithin(0,keep-this.start,this.length);
        this.length-=keep-this.start;
        this.start=keep;
      }
      return result.subarray(0,n);
    }
  }
  /*
   * A tab's recent 16 kHz audio (about eight seconds) and its completed STFT frames. Frame g covers
   * stream samples [g*512-1024, g*512+1024); within any window that starts on the 512-sample grid it
   * is exactly that window's frame, so only the frames near a window's edges are computed per reading.
   * advance() walks the fingerprinter's 256-sample hops: even hops are feature frames, whose FFT the
   * fingerprinter reuses; odd hops are computed only when fingerprints are wanted.
   */
  class FrameStream {
    constructor(constants,capacity=1<<17,cacheFrames=256) {
      this.constants=constants;
      this.capacity=capacity; this.mask=capacity-1;
      this.ring=new Float32Array(capacity);
      this.cache=Array.from({length:cacheFrames},newFrame); this.cacheMask=cacheFrames-1;
      this.zp=new Float64Array(FFT_SIZE); this.ep=new Float64Array(FFT_SIZE);
      this.scratch=newScratch();
      this.reset();
    }
    reset() {
      this.total=0;
      this.nextHop=0;
      for(const frame of this.cache)frame.g=-1;
    }
    push(samples) {
      for(let i=0;i<samples.length;i++)this.ring[(this.total+i)&this.mask]=samples[i];
      this.total+=samples.length;
    }
    at(index) { return this.ring[index&this.mask]; }
    copy(from,dst) { for(let k=0;k<FFT_SIZE;k++)dst[k]=this.ring[(from+k)&this.mask]; }
    /** Computes every hop whose 2048 samples have arrived; onPower(hop, power) sees each spectrum. */
    advance(wantOddHops,onPower) {
      while(this.nextHop*PRINT_HOP+FFT_SIZE<=this.total){
        const hop=this.nextHop++, from=hop*PRINT_HOP;
        if((hop&1)===0){
          const g=(hop>>1)+2, frame=this.cache[g&this.cacheMask];
          this.copy(from,this.zp);
          frameSummary(this.zp,this.zp,this.constants,frame,this.scratch);
          frame.g=g;
          if(onPower)onPower(hop,this.scratch.power);
        }else if(wantOddHops){
          this.copy(from,this.zp);
          powerSpectrum(this.zp,this.scratch);
          if(onPower)onPower(hop,this.scratch.power);
        }
      }
    }
    /** extractFeatures() of stream samples [start, end); start must lie on the 512-sample grid. */
    features(start,end) {
      const n=end-start;
      if(start%HOP!==0||n<FFT_SIZE||end>this.total||start<this.total-this.capacity)
        throw new Error('Window outside the buffered audio');
      const frameCount=1+Math.floor(n/HOP), first=start/HOP;
      const frames=new Array(frameCount);
      for(let k=0;k<frameCount;k++){
        const lo=k*HOP-FFT_SIZE/2;
        if(lo>=0&&lo+FFT_SIZE<=n){
          const g=first+k;
          let frame=this.cache[g&this.cacheMask];
          if(frame.g!==g){
            frame=newFrame();
            this.copy(start+lo,this.zp);
            frameSummary(this.zp,this.zp,this.constants,frame,this.scratch);
          }
          frames[k]=frame;
        }else{
          for(let j=0;j<FFT_SIZE;j++){
            const index=lo+j;
            this.zp[j]=(index<0||index>=n)?0:this.ring[(start+index)&this.mask];
            this.ep[j]=this.ring[(start+Math.min(n-1,Math.max(0,index)))&this.mask];
          }
          frames[k]=frameSummary(this.zp,this.ep,this.constants,newFrame(),this.scratch);
        }
      }
      return assemble(frames,this.constants);
    }
  }
  root.FootballClassifier={extractFeatures,predictLive,downsample,fft,powerSpectrum,frameSummary,
    StreamResampler,FrameStream,RATE,FFT_SIZE,HOP,PRINT_HOP,FEATURE_COUNT,RMS_MEAN_INDEX};
})(typeof globalThis !== 'undefined' ? globalThis : self);

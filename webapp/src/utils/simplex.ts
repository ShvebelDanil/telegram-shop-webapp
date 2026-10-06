/**
 * A lightweight, highly optimized Simplex Noise 2D implementation
 * to generate smooth topographic background waves.
 */
export class SimplexNoise {
  private grad3 = [
    [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
    [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
    [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]
  ];
  
  private p: number[] = [];
  private perm: number[] = new Array(512);
  private permMod12: number[] = new Array(512);

  constructor() {
    // Fill the permutation table with standard pseudorandom values
    const seed = [
      151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,8,99,37,240,21,10,23,
      190, 6,148,247,120,234,75,0,26,197,62,94,252,219,203,117,35,11,32,57,177,33,88,237,149,56,87,174,20,125,
      136,171,168, 68,175,74,165,71,134,139,150,111,104,195,78,196,84,114,83,76,223,109,244,124,189,121,34,52,76,
      27,103,118,221,21,64,254,44,72,127,110,182,22,233,103,248,154,223,14,92,235,193,97,23,212,47,11,94,252,142,
      24,81,51,143,109,250,80,218,115,224,124,172,0,239,249,64,53,110,224,74,206,120,135,60,114,80,252,223,129,
      233,244,111,54,10,21,218,172,25,13,124,116,211,210,121,12,165,144,162,19,244,252,190,205,168,142,141,128,124,
      142,128,183,127,139,19,71,114,151,109,91,138,95,147,172,144,176,228,0,147,204,115,17,33,12,44,22,25,124,219,
      111,159,10,21,30,45,167,2,14,113,228,159,120,4,201,111,136,90,144,162,31,109,233,194,54,219,202,211,209,251,
      200,31,109,233,203,117,35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,74,165,71,134,139
    ];

    for (let i = 0; i < 256; i++) {
      this.p[i] = seed[i];
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = this.p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  private dot(g: number[], x: number, y: number): number {
    return g[0] * x + g[1] * y;
  }

  public noise2D(xin: number, yin: number): number {
    let n0 = 0, n1 = 0, n2 = 0;
    
    // Skewing and unskewing factors for 2D
    const F2 = 0.5 * (Math.sqrt(3.0) - 1.0);
    const G2 = (3.0 - Math.sqrt(3.0)) / 6.0;
    
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    
    const t = (i + j) * G2;
    const X0 = i - t; 
    const Y0 = j - t;
    const x0 = xin - X0; 
    const y0 = yin - Y0;
    
    let i1: number, j1: number; 
    if (x0 > y0) {
      i1 = 1; j1 = 0; 
    } else {
      i1 = 0; j1 = 1; 
    }
    
    const x1 = x0 - i1 + G2; 
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1.0 + 2.0 * G2; 
    const y2 = y0 - 1.0 + 2.0 * G2;
    
    const ii = i & 255;
    const jj = j & 255;
    
    const gi0 = this.permMod12[ii + this.perm[jj]];
    const gi1 = this.permMod12[ii + i1 + this.perm[jj + j1]];
    const gi2 = this.permMod12[ii + 1 + this.perm[jj + 1]];
    
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 < 0) {
      n0 = 0.0;
    } else {
      t0 *= t0;
      n0 = t0 * t0 * this.dot(this.grad3[gi0], x0, y0);
    }
    
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 < 0) {
      n1 = 0.0;
    } else {
      t1 *= t1;
      n1 = t1 * t1 * this.dot(this.grad3[gi1], x1, y1);
    }
    
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 < 0) {
      n2 = 0.0;
    } else {
      t2 *= t2;
      n2 = t2 * t2 * this.dot(this.grad3[gi2], x2, y2);
    }
    
    return 70.0 * (n0 + n1 + n2);
  }
}

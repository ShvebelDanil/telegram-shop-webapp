import React, { useEffect, useRef } from 'react';
import { SimplexNoise } from '../utils/simplex';

export default function TopoBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const simplex = new SimplexNoise();
    let animationId: number;
    let time = 0;

    const resizeCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      ctx.scale(dpr, dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
    };

    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    const animate = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;

      // Draw deep rich dark background
      ctx.fillStyle = '#060606';
      ctx.fillRect(0, 0, width, height);

      // Topographic isolines drawing
      // Draw with soft grey/white stroke
      ctx.strokeStyle = 'rgba(235, 235, 235, 0.16)';
      ctx.lineWidth = 1.2;

      const lineSpacing = 16; // Purity and density of lines
      const resolution = 10;   // Step in pixels along each line

      // Loop from top to bottom with extra padding for overflow
      for (let y = -120; y < height + 120; y += lineSpacing) {
        ctx.beginPath();
        let first = true;

        for (let x = -40; x <= width + 40; x += resolution) {
          // Generate complex 3D noise using scaled coordinates and slow time
          const noise1 = simplex.noise2D(x * 0.002, y * 0.002 + time * 0.015);
          const noise2 = simplex.noise2D(x * 0.0045, y * 0.0045 - time * 0.005) * 0.35;
          const totalNoise = noise1 + noise2;

          // Vertical offset based on noise to mimic mountain hills/depths
          const yOffset = totalNoise * 90;

          if (first) {
            ctx.moveTo(x, y + yOffset);
            first = false;
          } else {
            ctx.lineTo(x, y + yOffset);
          }
        }
        ctx.stroke();
      }

      // Incredibly slow time evolution for that "very slowly changing" topography
      time += 0.003;
      animationId = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      cancelAnimationFrame(animationId);
    };
  }, []);

  return (
    <canvas
      id="canvas-bg"
      ref={canvasRef}
      className="fixed inset-0 w-full h-full pointer-events-none z-0 block bg-[#060606]"
    />
  );
}

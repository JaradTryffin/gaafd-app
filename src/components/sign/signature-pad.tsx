"use client";

import { forwardRef, useImperativeHandle, useRef } from "react";

export type SignaturePadHandle = {
  clear: () => void;
  toDataURL: () => string | null;
};

export const SignaturePad = forwardRef<SignaturePadHandle, { onInkChange: (hasInk: boolean) => void }>(
  function SignaturePad({ onInkChange }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const drawingRef = useRef(false);
    const lastRef = useRef<{ x: number; y: number } | null>(null);
    const hasInkRef = useRef(false);

    useImperativeHandle(ref, () => ({
      clear() {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
        hasInkRef.current = false;
        onInkChange(false);
      },
      toDataURL() {
        if (!hasInkRef.current || !canvasRef.current) return null;
        return canvasRef.current.toDataURL("image/png");
      },
    }));

    function setCanvasRef(node: HTMLCanvasElement | null) {
      canvasRef.current = node;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      if (!rect.width) return;
      node.width = rect.width * 2;
      node.height = rect.height * 2;
      const ctx = node.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.lineWidth = 2.4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#1c2e20";
    }

    function pos(e: React.PointerEvent<HTMLCanvasElement>) {
      const rect = e.currentTarget.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
      e.preventDefault();
      drawingRef.current = true;
      lastRef.current = pos(e);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Some browsers reject capture for certain pointer types — drawing
        // still works without it, just without guaranteed event delivery
        // outside the canvas bounds.
      }
      if (!hasInkRef.current) {
        hasInkRef.current = true;
        onInkChange(true);
      }
    }

    function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
      if (!drawingRef.current || !canvasRef.current || !lastRef.current) return;
      const ctx = canvasRef.current.getContext("2d");
      if (!ctx) return;
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(lastRef.current.x, lastRef.current.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      lastRef.current = p;
    }

    function handlePointerUp() {
      drawingRef.current = false;
    }

    return (
      <canvas
        ref={setCanvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ touchAction: "none", cursor: "crosshair" }}
        className="block h-full w-full"
      />
    );
  },
);

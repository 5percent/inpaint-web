/// <reference types="vite/client" />

interface GPUAdapter {}

interface GPU {
  requestAdapter(): Promise<GPUAdapter | null>
}

interface Navigator {
  gpu?: GPU
}

declare const ort: any

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type Position = [number, number];
type Ring = Position[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

export type Cm93WebGpuCandidateBenchmark = {
  status: 'completed';
  polygonFeatureCount: number;
  coverageComponentCount: number;
  pairCount: number;
  candidatePairCount: number;
  cpuMedianMs: number;
  gpuSetupMs: number;
  gpuMedianDispatchReadbackMs: number;
  gpuTotalMedianMs: number;
  equivalent: boolean;
  adapter: string;
  note: string;
};

function boundsFromCoordinates(value: unknown): Bounds | null {
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let found = false;
  const visit = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') {
      bounds.minX = Math.min(bounds.minX, node[0]);
      bounds.minY = Math.min(bounds.minY, node[1]);
      bounds.maxX = Math.max(bounds.maxX, node[0]);
      bounds.maxY = Math.max(bounds.maxY, node[1]);
      found = true;
      return;
    }
    for (const child of node) visit(child);
  };
  visit(value);
  return found ? bounds : null;
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX &&
    a.minY <= b.maxY && a.maxY >= b.minY;
}

function polygonFeatureBounds(features: GeoJSON.Feature[]): Bounds[] {
  const result: Bounds[] = [];
  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) continue;
    const objectClass = String(feature.properties?.cm93Class ?? '').toUpperCase();
    if (objectClass === '_M_SOR' || objectClass === 'M_COVR' || objectClass === 'M_PROD') continue;
    const bounds = boundsFromCoordinates(geometry.coordinates);
    if (bounds) result.push(bounds);
  }
  return result;
}

function coverageComponentBounds(coverage: MultiPolygon): Bounds[] {
  return coverage.map((polygon) => boundsFromCoordinates(polygon)).filter((bounds): bounds is Bounds => bounds !== null);
}

function packBounds(bounds: Bounds[]): Float32Array {
  const packed = new Float32Array(bounds.length * 4);
  bounds.forEach((item, index) => {
    packed[index * 4] = item.minX;
    packed[index * 4 + 1] = item.minY;
    packed[index * 4 + 2] = item.maxX;
    packed[index * 4 + 3] = item.maxY;
  });
  return packed;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * Experimental WebGPU broad phase for CM93 polygon clipping.
 *
 * It computes feature-bounds x coverage-component-bounds overlap in parallel.
 * The exact polygon Boolean intersection deliberately remains on the current
 * CPU clipping engine: this experiment cannot change chart geometry or portrayal.
 */
export async function benchmarkCm93WebGpuPolygonCandidates(
  features: GeoJSON.Feature[],
  coverage: MultiPolygon,
): Promise<Cm93WebGpuCandidateBenchmark> {
  const gpuProvider = (navigator as Navigator & { gpu?: any }).gpu;
  if (!gpuProvider) throw new Error('WebGPU is not available in this browser. Try a browser with WebGPU enabled on a supported GPU/driver.');

  const featureBounds = polygonFeatureBounds(features);
  const componentBounds = coverageComponentBounds(coverage);
  if (!featureBounds.length || !componentBounds.length) {
    throw new Error('The current viewport has no polygon features or effective coverage components to benchmark.');
  }
  const pairCount = featureBounds.length * componentBounds.length;
  if (pairCount > 8_000_000) {
    throw new Error('The candidate matrix would be too large for a safe browser benchmark (' + pairCount.toLocaleString() + ' pairs).');
  }

  const cpuCandidates = (): number[] => {
    const candidates: number[] = [];
    for (let featureIndex = 0; featureIndex < featureBounds.length; featureIndex++) {
      for (let componentIndex = 0; componentIndex < componentBounds.length; componentIndex++) {
        if (overlaps(featureBounds[featureIndex], componentBounds[componentIndex])) {
          candidates.push(featureIndex * componentBounds.length + componentIndex);
        }
      }
    }
    return candidates;
  };

  const cpuTimes: number[] = [];
  let expected: number[] = [];
  for (let iteration = 0; iteration < 6; iteration++) {
    const start = performance.now();
    const candidates = cpuCandidates();
    cpuTimes.push(performance.now() - start);
    if (iteration === 0) expected = candidates;
  }

  const setupStart = performance.now();
  const bufferUsage = (globalThis as any).GPUBufferUsage ?? { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, STORAGE: 128 };
  const mapMode = (globalThis as any).GPUMapMode ?? { READ: 1 };
  const adapter = await gpuProvider.requestAdapter();
  if (!adapter) throw new Error('WebGPU could not acquire a GPU adapter.');
  const device = await adapter.requestDevice();
  const shader = device.createShaderModule({
    label: 'CM93 polygon candidate bounds overlap',
    code: `
      @group(0) @binding(0) var<storage, read> featureBounds: array<vec4<f32>>;
      @group(0) @binding(1) var<storage, read> coverageBounds: array<vec4<f32>>;
      @group(0) @binding(2) var<storage, read_write> candidates: array<u32>;

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
        let pairIndex = globalId.x;
        if (pairIndex >= arrayLength(&candidates)) { return; }
        let componentCount = arrayLength(&coverageBounds);
        let featureIndex = pairIndex / componentCount;
        let componentIndex = pairIndex % componentCount;
        let a = featureBounds[featureIndex];
        let b = coverageBounds[componentIndex];
        let overlap = a.x <= b.z && a.z >= b.x && a.y <= b.w && a.w >= b.y;
        candidates[pairIndex] = select(0u, 1u, overlap);
      }
    `,
  });
  const pipeline = device.createComputePipeline({
    label: 'CM93 polygon candidate bounds pipeline',
    layout: 'auto',
    compute: { module: shader, entryPoint: 'main' },
  });
  const featureData = packBounds(featureBounds);
  const coverageData = packBounds(componentBounds);
  const featureBuffer = device.createBuffer({
    size: featureData.byteLength,
    usage: bufferUsage.STORAGE | bufferUsage.COPY_DST,
  });
  const coverageBuffer = device.createBuffer({
    size: coverageData.byteLength,
    usage: bufferUsage.STORAGE | bufferUsage.COPY_DST,
  });
  const outputBuffer = device.createBuffer({
    size: pairCount * Uint32Array.BYTES_PER_ELEMENT,
    usage: bufferUsage.STORAGE | bufferUsage.COPY_SRC,
  });
  const readBuffer = device.createBuffer({
    size: pairCount * Uint32Array.BYTES_PER_ELEMENT,
    usage: bufferUsage.COPY_DST | bufferUsage.MAP_READ,
  });
  device.queue.writeBuffer(featureBuffer, 0, featureData);
  device.queue.writeBuffer(coverageBuffer, 0, coverageData);
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: featureBuffer } },
      { binding: 1, resource: { buffer: coverageBuffer } },
      { binding: 2, resource: { buffer: outputBuffer } },
    ],
  });
  const gpuSetupMs = performance.now() - setupStart;

  const gpuTimes: number[] = [];
  let gpuCandidates: number[] = [];
  for (let iteration = 0; iteration < 6; iteration++) {
    const start = performance.now();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(pairCount / 64));
    pass.end();
    encoder.copyBufferToBuffer(outputBuffer, 0, readBuffer, 0, pairCount * Uint32Array.BYTES_PER_ELEMENT);
    device.queue.submit([encoder.finish()]);
    await readBuffer.mapAsync(mapMode.READ);
    const values = new Uint32Array(readBuffer.getMappedRange().slice(0));
    readBuffer.unmap();
    gpuTimes.push(performance.now() - start);
    if (iteration === 0) {
      gpuCandidates = [];
      for (let index = 0; index < values.length; index++) {
        if (values[index] === 1) gpuCandidates.push(index);
      }
    }
  }

  featureBuffer.destroy();
  coverageBuffer.destroy();
  outputBuffer.destroy();
  readBuffer.destroy();
  device.destroy();

  const equivalent = expected.length === gpuCandidates.length &&
    expected.every((value, index) => value === gpuCandidates[index]);
  const adapterInfo = typeof adapter.info === 'object' && adapter.info
    ? [adapter.info.vendor, adapter.info.architecture, adapter.info.device].filter(Boolean).join(' / ')
    : 'GPU adapter information unavailable';

  return {
    status: 'completed',
    polygonFeatureCount: featureBounds.length,
    coverageComponentCount: componentBounds.length,
    pairCount,
    candidatePairCount: expected.length,
    cpuMedianMs: median(cpuTimes.slice(1)),
    gpuSetupMs,
    gpuMedianDispatchReadbackMs: median(gpuTimes.slice(1)),
    gpuTotalMedianMs: gpuSetupMs + median(gpuTimes.slice(1)),
    equivalent,
    adapter: adapterInfo,
    note: 'This GPU experiment accelerates only the conservative bounding-box candidate stage. Exact polygon Boolean clipping remains on the selected CPU engine.',
  };
}
